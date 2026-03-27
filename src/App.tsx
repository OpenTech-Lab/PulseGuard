import {
  ArcElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import type { ChartOptions } from "chart.js";
import { listen } from "@tauri-apps/api/event";
import { startTransition, useDeferredValue, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Line } from "react-chartjs-2";
import { exportSamples, getDashboard, getHistory, setMonitorMode, updateSettings } from "./lib/api";
import type {
  DashboardPayload,
  DashboardSnapshot,
  ExportFormat,
  MonitorMode,
  MonitorSettings,
  ProcessSample,
  StatusPayload,
} from "./types";

ChartJS.register(
  ArcElement,
  CategoryScale,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
);

const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

const historyRangeOptions = [6, 12, 24, 72];
const BYTES_PER_GB = 1024 ** 3;

type SortKey =
  | "name"
  | "cpu_percent"
  | "mem_bytes"
  | "disk_read_bytes"
  | "disk_write_bytes"
  | "net_recv_bytes"
  | "net_sent_bytes";

type TabKey = "activity" | "settings" | "processes";
const matrixGlyphs = [
  "10100101",
  "SYS",
  "TRACE",
  "KERNEL",
  "IO",
  "NET",
  "MEM",
  "PID",
  "STACK",
  "0x7f",
  "LOCK",
  "WAKE",
];

function formatPercent(value: number) {
  return `${numberFormat.format(value)}%`;
}

function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let remainder = value;
  let unitIndex = 0;
  while (remainder >= 1024 && unitIndex < units.length - 1) {
    remainder /= 1024;
    unitIndex += 1;
  }
  return `${numberFormat.format(remainder)} ${units[unitIndex]}`;
}

function formatGigabytes(value: number) {
  const gigabytes = value / BYTES_PER_GB;
  const maximumFractionDigits = gigabytes >= 100 ? 0 : gigabytes >= 10 ? 1 : gigabytes >= 1 ? 2 : 3;

  return `${gigabytes.toLocaleString("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  })} GB`;
}

function formatCompactBytes(value: number) {
  const units = ["B", "K", "M", "G", "T"];
  let remainder = value;
  let unitIndex = 0;

  while (remainder >= 1024 && unitIndex < units.length - 1) {
    remainder /= 1024;
    unitIndex += 1;
  }

  const digits = remainder >= 100 || unitIndex === 0 ? 0 : 1;
  return `${remainder.toFixed(digits)}${units[unitIndex]}`;
}

function formatTimestamp(value: string | null) {
  if (!value) {
    return "Waiting for first sample";
  }

  const timestamp = new Date(value);
  return timestamp.toLocaleString();
}

function buildRainColumn(index: number) {
  return Array.from({ length: 18 }, (_, line) => matrixGlyphs[(index * 2 + line) % matrixGlyphs.length]).join("\n");
}

function buildChartOptions(
  label: string,
  valueMode: "bytes" | "gigabytes" | "percent" = "percent",
): ChartOptions<"line"> {
  return {
    animation: false,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        labels: {
          color: "#8dff9c",
          font: {
            family: "IBM Plex Mono, JetBrains Mono, monospace",
            size: 11,
          },
          usePointStyle: true,
          boxWidth: 10,
        },
      },
      tooltip: {
        backgroundColor: "rgba(5, 17, 8, 0.96)",
        bodyColor: "#c8ffd2",
        borderColor: "rgba(110, 255, 110, 0.28)",
        borderWidth: 1,
        callbacks: {
          label: (context) => {
            const value = Number(context.parsed.y ?? 0);
            const formatted =
              valueMode === "bytes"
                ? formatCompactBytes(value)
                : valueMode === "gigabytes"
                  ? formatGigabytes(value)
                  : formatPercent(value);
            return `${context.dataset.label}: ${formatted}`;
          },
        },
        mode: "index" as const,
        intersect: false,
        titleColor: "#effff2",
      },
    },
    responsive: true,
    scales: {
      x: {
        grid: {
          color: "rgba(85, 255, 122, 0.08)",
        },
        ticks: {
          color: "rgba(150, 255, 170, 0.56)",
          font: {
            family: "IBM Plex Mono, JetBrains Mono, monospace",
            size: 10,
          },
          maxRotation: 0,
        },
      },
      y: {
        beginAtZero: true,
        grid: {
          color: "rgba(85, 255, 122, 0.08)",
        },
        ticks: {
          callback: (value) =>
            valueMode === "bytes"
              ? formatCompactBytes(Number(value))
              : valueMode === "gigabytes"
                ? formatGigabytes(Number(value))
              : formatPercent(Number(value)),
          color: "rgba(150, 255, 170, 0.56)",
          font: {
            family: "IBM Plex Mono, JetBrains Mono, monospace",
            size: 10,
          },
        },
        title: {
          color: "rgba(209, 255, 220, 0.84)",
          display: true,
          font: {
            family: "IBM Plex Mono, JetBrains Mono, monospace",
            size: 11,
          },
          text: label,
        },
      },
    },
  };
}

function StatusBadge({ status }: { status: MonitorMode }) {
  const config = {
    paused: {
      dot: "bg-amber-300",
      label: "Paused",
      tone: "text-amber-200 border-amber-500/30",
    },
    running: {
      dot: "bg-lime-300",
      label: "Running",
      tone: "text-lime-100 border-lime-400/30",
    },
    stopped: {
      dot: "bg-rose-400",
      label: "Stopped",
      tone: "text-rose-200 border-rose-500/30",
    },
  }[status];

  return (
    <div
      className={`inline-flex items-center gap-3 rounded-md border px-4 py-2 text-xs font-semibold uppercase tracking-[0.28em] ${config.tone}`}
      style={{ background: "rgba(6, 18, 10, 0.9)", boxShadow: "var(--matrix-edge)" }}
    >
      <span className={`h-2 w-2 rounded-full ${config.dot} shadow-[0_0_12px_currentColor]`} />
      {config.label}
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="soft-panel animate-pulse-enter matrix-card p-4">
      <div className="text-[11px] uppercase tracking-[0.3em]" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
      <div className="mt-2 font-mono text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
        {value}
      </div>
      {detail ? (
        <div className="mt-1 text-[11px] uppercase tracking-[0.18em]" style={{ color: "var(--text-secondary)" }}>
          {detail}
        </div>
      ) : null}
    </div>
  );
}

function MatrixBackdrop() {
  return (
    <div aria-hidden="true" className="matrix-backdrop">
      <div className="matrix-noise" />
      <div className="matrix-grid-lines" />
      <div className="matrix-glow matrix-glow-left" />
      <div className="matrix-glow matrix-glow-right" />
      <div className="matrix-rain">
        {Array.from({ length: 14 }, (_, index) => (
          <span
            key={index}
            className="rain-column"
            style={
              {
                animationDelay: `-${index * 1.2}s`,
                animationDuration: `${14 + (index % 4) * 2}s`,
                left: `${index * 7.4}%`,
              } as CSSProperties
            }
          >
            {buildRainColumn(index)}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<MonitorSettings | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [historyHours, setHistoryHours] = useState(24);
  const [search, setSearch] = useState("");
  const [minCpu, setMinCpu] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("cpu_percent");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [activeTab, setActiveTab] = useState<TabKey>("activity");
  const deferredSearch = useDeferredValue(search);

  async function hydrate(rangeHours: number) {
    try {
      setError(null);
      const next = await getDashboard(rangeHours);
      startTransition(() => {
        setDashboard(next);
        setSettingsDraft((current) => current ?? next.settings);
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }

  async function refreshHistory(rangeHours: number) {
    try {
      const nextHistory = await getHistory(rangeHours);
      startTransition(() => {
        setDashboard((current) =>
          current
            ? {
                ...current,
                history: nextHistory,
              }
            : current,
        );
      });
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : String(historyError));
    }
  }

  useEffect(() => {
    void hydrate(historyHours);
  }, [historyHours]);

  useEffect(() => {
    let unlistenSample: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;

    const register = async () => {
      unlistenSample = await listen<DashboardSnapshot>("monitor://sample", (event) => {
        startTransition(() => {
          setDashboard((current) =>
            current
              ? {
                  ...current,
                  snapshot: event.payload,
                }
              : current,
          );
        });
        void refreshHistory(historyHours);
      });

      unlistenStatus = await listen<StatusPayload>("monitor://status", (event) => {
        startTransition(() => {
          setDashboard((current) =>
            current
              ? {
                  ...current,
                  status: event.payload.status,
                }
              : current,
          );
        });
      });
    };

    void register();

    return () => {
      unlistenSample?.();
      unlistenStatus?.();
    };
  }, [historyHours]);

  async function applyMonitorMode(mode: MonitorMode) {
    try {
      setBusyAction(mode);
      setError(null);
      const nextStatus = await setMonitorMode(mode);
      startTransition(() => {
        setDashboard((current) =>
          current
            ? {
                ...current,
                status: nextStatus,
              }
            : current,
        );
      });
      setMessage(`Monitoring ${nextStatus}.`);
    } catch (modeError) {
      setError(modeError instanceof Error ? modeError.message : String(modeError));
    } finally {
      setBusyAction(null);
    }
  }

  async function saveSettings() {
    if (!settingsDraft) {
      return;
    }

    try {
      setBusyAction("settings");
      setError(null);
      const nextSettings = await updateSettings(settingsDraft);
      startTransition(() => {
        setSettingsDraft(nextSettings);
        setDashboard((current) =>
          current
            ? {
                ...current,
                settings: nextSettings,
              }
            : current,
        );
      });
      setMessage("Settings saved.");
    } catch (settingsError) {
      setError(settingsError instanceof Error ? settingsError.message : String(settingsError));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleExport(format: ExportFormat) {
    try {
      setBusyAction(`export-${format}`);
      setError(null);
      const result = await exportSamples(format, historyHours);
      setMessage(`Exported ${result.rows} rows to ${result.path}`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setBusyAction(null);
    }
  }

  const rows = dashboard?.snapshot.processes ?? [];
  const filteredRows = rows
    .filter((row) =>
      row.name.toLowerCase().includes(deferredSearch.trim().toLowerCase()) ||
      String(row.pid).includes(deferredSearch.trim()),
    )
    .filter((row) => row.cpu_percent >= minCpu)
    .sort((left, right) => {
      const leftValue = left[sortKey];
      const rightValue = right[sortKey];
      if (typeof leftValue === "string" && typeof rightValue === "string") {
        return sortDirection === "asc"
          ? leftValue.localeCompare(rightValue)
          : rightValue.localeCompare(leftValue);
      }

      const numericLeft = Number(leftValue);
      const numericRight = Number(rightValue);
      return sortDirection === "asc"
        ? numericLeft - numericRight
        : numericRight - numericLeft;
    });

  const chartLabels = (dashboard?.history ?? []).map((point) =>
    new Date(point.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
  );

  const cpuHistory = {
    datasets: [
      {
        backgroundColor: "rgba(80, 255, 118, 0.14)",
        borderColor: "rgba(118, 255, 145, 0.96)",
        borderWidth: 2,
        data: (dashboard?.history ?? []).map((point) => point.cpu_total),
        fill: true,
        label: "CPU_SIGNAL",
        pointRadius: 0,
        tension: 0.32,
      },
    ],
    labels: chartLabels,
  };

  const memoryHistory = {
    datasets: [
      {
        backgroundColor: "rgba(147, 255, 95, 0.1)",
        borderColor: "rgba(189, 255, 112, 0.92)",
        borderWidth: 2,
        data: (dashboard?.history ?? []).map((point) => point.mem_total_bytes),
        fill: true,
        label: "MEMORY_BANK",
        pointRadius: 0,
        tension: 0.32,
      },
    ],
    labels: chartLabels,
  };

  const networkHistory = {
    datasets: [
      {
        backgroundColor: "rgba(74, 255, 173, 0.08)",
        borderColor: "rgba(103, 255, 179, 0.9)",
        borderWidth: 2,
        data: (dashboard?.history ?? []).map((point) => point.net_recv_total),
        fill: true,
        label: "NET_RX",
        pointRadius: 0,
        tension: 0.32,
      },
      {
        backgroundColor: "rgba(39, 192, 102, 0.07)",
        borderColor: "rgba(73, 233, 137, 0.8)",
        borderWidth: 2,
        data: (dashboard?.history ?? []).map((point) => point.net_sent_total),
        fill: true,
        label: "NET_TX",
        pointRadius: 0,
        tension: 0.32,
      },
    ],
    labels: chartLabels,
  };

  const diskHistory = {
    datasets: [
      {
        backgroundColor: "rgba(126, 255, 112, 0.08)",
        borderColor: "rgba(156, 255, 138, 0.88)",
        borderWidth: 2,
        data: (dashboard?.history ?? []).map((point) => point.disk_read_total),
        fill: true,
        label: "DISK_RX",
        pointRadius: 0,
        tension: 0.32,
      },
      {
        backgroundColor: "rgba(74, 200, 96, 0.06)",
        borderColor: "rgba(102, 234, 124, 0.8)",
        borderWidth: 2,
        data: (dashboard?.history ?? []).map((point) => point.disk_write_total),
        fill: true,
        label: "DISK_TX",
        pointRadius: 0,
        tension: 0.32,
      },
    ],
    labels: chartLabels,
  };

  function toggleSort(nextKey: SortKey) {
    if (sortKey === nextKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortKey(nextKey);
    setSortDirection(nextKey === "name" ? "asc" : "desc");
  }

  const tabs: Array<{ detail: string; key: TabKey; label: string }> = [
    {
      detail: "",
      key: "activity",
      label: "Signal Deck",
    },
    {
      detail: "",
      key: "settings",
      label: "Control Deck",
    },
    {
      detail: "",
      key: "processes",
      label: "Process Ledger",
    },
  ];

  if (!dashboard || !settingsDraft) {
    return (
      <main className="matrix-shell mx-auto flex min-h-screen max-w-6xl items-center justify-center px-4 py-12">
        <MatrixBackdrop />
        <div className="glass-panel max-w-lg p-8 text-center">
          <div className="hero-kicker text-sm uppercase tracking-[0.3em]" style={{ color: "var(--text-secondary)" }}>
            PulseGuard Console
          </div>
          <h1 className="hero-title mt-3 text-3xl font-semibold">Bootstrapping deck</h1>
        </div>
      </main>
    );
  }

  const primaryMonitorAction =
    dashboard.status === "running"
      ? { label: "Pause Monitoring", nextMode: "paused" as const }
      : { label: "Start Monitoring", nextMode: "running" as const };

  return (
    <main className="matrix-shell mx-auto flex min-h-screen max-w-6xl flex-col gap-5 px-4 py-4 lg:px-6">
      <MatrixBackdrop />
      <section className="glass-panel overflow-hidden p-4 lg:p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            <button
              className={`control-chip ${
                dashboard.status === "running"
                  ? "border-lime-300/40 bg-lime-500/18 text-lime-50"
                  : ""
              }`}
              disabled={busyAction !== null}
              onClick={() => void applyMonitorMode(primaryMonitorAction.nextMode)}
              type="button"
            >
              {primaryMonitorAction.label}
            </button>
            <button
              className="control-chip"
              disabled={busyAction !== null}
              onClick={() => void applyMonitorMode("stopped")}
              type="button"
            >
              Stop
            </button>
            <button
              className="control-chip"
              disabled={busyAction !== null}
              onClick={() => void handleExport("csv")}
              type="button"
            >
              Export CSV
            </button>
            <button
              className="control-chip"
              disabled={busyAction !== null}
              onClick={() => void handleExport("json")}
              type="button"
            >
              Export JSON
            </button>
          </div>
          <StatusBadge status={dashboard.status} />
        </div>

        <div className="grid gap-4">
          <div>
            <div className="hero-kicker text-[11px] uppercase tracking-[0.32em]" style={{ color: "var(--text-secondary)" }}>
              Zion Node 01 / Live Monitor
            </div>
            <div className="hero-readout mt-3 grid gap-2 sm:grid-cols-3">
              <div className="soft-panel px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.28em]" style={{ color: "var(--text-muted)" }}>
                  Sync
                </div>
                <div className="mt-1 font-mono text-xs" style={{ color: "var(--text-primary)" }}>
                  {formatTimestamp(dashboard.snapshot.timestamp)}
                </div>
              </div>
              <div className="soft-panel px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.28em]" style={{ color: "var(--text-muted)" }}>
                  Step
                </div>
                <div className="mt-1 font-mono text-xs" style={{ color: "var(--text-primary)" }}>
                  {settingsDraft.interval_secs}s interval
                </div>
              </div>
              <div className="soft-panel px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.28em]" style={{ color: "var(--text-muted)" }}>
                  Retention
                </div>
                <div className="mt-1 font-mono text-xs" style={{ color: "var(--text-primary)" }}>
                  {settingsDraft.retention_days} day archive
                </div>
              </div>
            </div>
            <div className="soft-panel mt-3 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="font-mono text-[11px]" style={{ color: "var(--text-secondary)" }}>
                  archive://pulseguard.db
                </span>
                <span className="text-[11px] uppercase tracking-[0.28em]" style={{ color: "var(--text-muted)" }}>
                  Signal Matrix
                </span>
              </div>
              <div className="grid gap-3 lg:grid-cols-4">
                <MetricCard label="Process Count" value={String(dashboard.snapshot.totals.process_count)} />
                <MetricCard label="CPU Load" value={formatPercent(dashboard.snapshot.totals.cpu_total)} />
                <MetricCard
                  label="Memory Bank"
                  value={formatGigabytes(dashboard.snapshot.totals.mem_total_bytes)}
                  detail={
                    dashboard.snapshot.totals.memory_capacity_bytes > 0
                      ? `${formatGigabytes(dashboard.snapshot.totals.memory_capacity_bytes)} max`
                      : undefined
                  }
                />
                <MetricCard
                  label="Net Flux"
                  value={`${formatCompactBytes(dashboard.snapshot.totals.net_recv_total)}↓ / ${formatCompactBytes(dashboard.snapshot.totals.net_sent_total)}↑`}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {error ? (
        <section className="glass-panel message-panel border-rose-300/40 p-3 text-xs text-rose-200">
          <span className="message-tag">Alert</span>
          {error}
        </section>
      ) : null}

      {message ? (
        <section className="glass-panel message-panel p-3 text-xs text-lime-100">
          <span className="message-tag">System</span>
          {message}
        </section>
      ) : null}

      <section className="glass-panel p-2">
        <div className="grid gap-2 md:grid-cols-3">
          {tabs.map((tab) => {
            const selected = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                aria-pressed={selected}
                className="tab-button"
                data-active={selected ? "true" : "false"}
                onClick={() => setActiveTab(tab.key)}
                type="button"
              >
                <div className="text-xs font-semibold uppercase tracking-[0.24em]">{tab.label}</div>
              </button>
            );
          })}
        </div>
      </section>

      {activeTab === "activity" ? (
        <section className="glass-panel min-w-0 overflow-hidden p-4 lg:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="section-title text-xl font-semibold">Signal Deck</h2>
            </div>
            <div className="flex flex-wrap gap-2">
              {historyRangeOptions.map((option) => (
                <button
                  key={option}
                  className={`control-chip ${historyHours === option ? "border-transparent bg-accent-500/90 text-white" : ""}`}
                  onClick={() => setHistoryHours(option)}
                  type="button"
                >
                  {option}h
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2">
            <div className="grid min-w-0 gap-3">
              <div className="soft-panel chart-shell h-56 min-w-0 overflow-hidden p-3">
                <div className="h-full min-w-0">
                  <Line data={cpuHistory} options={buildChartOptions("CPU %", "percent")} />
                </div>
              </div>
              <div className="soft-panel chart-shell h-56 min-w-0 overflow-hidden p-3">
                <div className="h-full min-w-0">
                  <Line data={memoryHistory} options={buildChartOptions("Memory GB", "gigabytes")} />
                </div>
              </div>
            </div>
            <div className="grid min-w-0 gap-3">
              <div className="soft-panel chart-shell h-56 min-w-0 overflow-hidden p-3">
                <div className="h-full min-w-0">
                  <Line data={networkHistory} options={buildChartOptions("Net I/O", "bytes")} />
                </div>
              </div>
              <div className="soft-panel chart-shell h-56 min-w-0 overflow-hidden p-3">
                <div className="h-full min-w-0">
                  <Line data={diskHistory} options={buildChartOptions("Disk I/O", "bytes")} />
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {activeTab === "settings" ? (
        <section className="glass-panel p-4 lg:p-5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="section-title text-xl font-semibold">Control Deck</h2>
            </div>
            <button
              className="control-chip"
              disabled={busyAction !== null}
              onClick={() => void saveSettings()}
              type="button"
            >
              Save
            </button>
          </div>
          <div className="mt-4 grid gap-3">
            <label className="grid gap-2 text-sm font-medium">
              Sampling interval (seconds)
              <input
                className="field"
                min={3}
                onChange={(event) =>
                  setSettingsDraft((current) =>
                    current
                      ? {
                          ...current,
                          interval_secs: Number(event.target.value),
                        }
                      : current,
                  )
                }
                type="number"
                value={settingsDraft.interval_secs}
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              Retention window (days)
              <input
                className="field"
                min={1}
                onChange={(event) =>
                  setSettingsDraft((current) =>
                    current
                      ? {
                          ...current,
                          retention_days: Number(event.target.value),
                        }
                      : current,
                  )
                }
                type="number"
                value={settingsDraft.retention_days}
              />
            </label>
            <label className="soft-panel flex items-center justify-between gap-3 px-3 py-2 text-sm font-medium">
              <span>Start monitoring on launch</span>
              <input
                checked={settingsDraft.auto_start}
                className="h-5 w-5 rounded border border-lime-500/40 bg-black/70"
                onChange={(event) =>
                  setSettingsDraft((current) =>
                    current
                      ? {
                          ...current,
                          auto_start: event.target.checked,
                        }
                      : current,
                  )
                }
                type="checkbox"
              />
            </label>
            <div className="soft-panel p-3 text-sm" style={{ color: "var(--text-secondary)" }}>
              <div className="font-semibold uppercase tracking-[0.2em]" style={{ color: "var(--text-primary)" }}>
                Export folder
              </div>
              <div className="mt-2 break-all font-mono text-[11px]">{dashboard.export_dir}</div>
            </div>
          </div>
        </section>
      ) : null}

      {activeTab === "processes" ? (
        <section className="glass-panel p-4 lg:p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="section-title text-xl font-semibold">Process Ledger</h2>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:w-[26rem]">
              <input
                className="field"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search process name or PID"
                type="search"
                value={search}
              />
              <label className="grid gap-2 text-sm font-medium">
                Min CPU %
                <input
                  className="field"
                  min={0}
                  onChange={(event) => setMinCpu(Number(event.target.value))}
                  step={0.1}
                  type="number"
                  value={minCpu}
                />
              </label>
            </div>
          </div>
          <div className="mt-3 overflow-x-auto table-shell">
            <table className="min-w-full border-separate border-spacing-y-2 text-left text-sm">
              <thead>
                <tr style={{ color: "var(--text-muted)" }}>
                  {[
                    ["name", "Process"],
                    ["cpu_percent", "CPU"],
                    ["mem_bytes", "Memory"],
                    ["disk_read_bytes", "Disk Read"],
                    ["disk_write_bytes", "Disk Write"],
                    ["net_recv_bytes", "Net Recv"],
                    ["net_sent_bytes", "Net Sent"],
                  ].map(([key, label]) => (
                    <th key={key} className="px-3 py-2 font-medium">
                      <button
                        className="flex items-center gap-2 uppercase tracking-[0.18em]"
                        onClick={() => toggleSort(key as SortKey)}
                        type="button"
                      >
                        {label}
                        {sortKey === key ? (sortDirection === "asc" ? "↑" : "↓") : ""}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row: ProcessSample) => (
                  <tr key={`${row.pid}-${row.timestamp}`} className="soft-panel process-row">
                    <td className="rounded-l-2xl px-3 py-2.5">
                      <div className="font-semibold uppercase tracking-[0.08em]">{row.name}</div>
                      <div className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
                        PID {row.pid}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono">{formatPercent(row.cpu_percent)}</td>
                    <td className="px-3 py-2.5 font-mono">{formatGigabytes(row.mem_bytes)}</td>
                    <td className="px-3 py-2.5 font-mono">{formatBytes(row.disk_read_bytes)}</td>
                    <td className="px-3 py-2.5 font-mono">{formatBytes(row.disk_write_bytes)}</td>
                    <td className="px-3 py-2.5 font-mono">{formatCompactBytes(row.net_recv_bytes)}</td>
                    <td className="rounded-r-2xl px-3 py-2.5 font-mono">{formatCompactBytes(row.net_sent_bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredRows.length === 0 ? (
              <div
                className="soft-panel mt-4 px-4 py-6 text-center text-sm"
                style={{ color: "var(--text-secondary)" }}
              >
                No processes matched the current filter.
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </main>
  );
}
