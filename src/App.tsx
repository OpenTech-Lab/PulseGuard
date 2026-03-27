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

type SortKey =
  | "name"
  | "cpu_percent"
  | "mem_percent"
  | "disk_read_bytes"
  | "disk_write_bytes"
  | "net_recv_bytes"
  | "net_sent_bytes";

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

function formatTimestamp(value: string | null) {
  if (!value) {
    return "Waiting for first sample";
  }

  const timestamp = new Date(value);
  return timestamp.toLocaleString();
}

function buildChartOptions(label: string): ChartOptions<"line"> {
  return {
    animation: false,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        labels: {
          usePointStyle: true,
          boxWidth: 10,
        },
      },
      tooltip: {
        mode: "index" as const,
        intersect: false,
      },
    },
    responsive: true,
    scales: {
      x: {
        grid: {
          color: "rgba(127, 216, 173, 0.08)",
        },
        ticks: {
          maxRotation: 0,
        },
      },
      y: {
        beginAtZero: true,
        grid: {
          color: "rgba(127, 216, 173, 0.08)",
        },
        title: {
          display: true,
          text: label,
        },
      },
    },
  };
}

function StatusBadge({ status }: { status: MonitorMode }) {
  const config = {
    paused: {
      dot: "bg-amber-400",
      label: "Paused",
      tone: "text-amber-600 dark:text-amber-300",
    },
    running: {
      dot: "bg-accent-500",
      label: "Running",
      tone: "text-accent-700 dark:text-accent-300",
    },
    stopped: {
      dot: "bg-rose-400",
      label: "Stopped",
      tone: "text-rose-600 dark:text-rose-300",
    },
  }[status];

  return (
    <div
      className={`inline-flex items-center gap-3 rounded-full border px-4 py-2 text-sm font-semibold ${config.tone}`}
      style={{ borderColor: "var(--line-soft)", background: "var(--bg-soft)" }}
    >
      <span className={`h-2.5 w-2.5 rounded-full ${config.dot}`} />
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
  detail: string;
}) {
  return (
    <div className="soft-panel animate-pulse-enter p-5">
      <div className="text-sm uppercase tracking-[0.18em]" style={{ color: "var(--text-secondary)" }}>
        {label}
      </div>
      <div className="mt-3 text-3xl font-semibold" style={{ color: "var(--text-primary)" }}>
        {value}
      </div>
      <div className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
        {detail}
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
        backgroundColor: "rgba(30, 167, 104, 0.14)",
        borderColor: "rgba(30, 167, 104, 0.95)",
        borderWidth: 2,
        data: (dashboard?.history ?? []).map((point) => point.cpu_total),
        fill: true,
        label: "CPU",
        pointRadius: 0,
        tension: 0.32,
      },
    ],
    labels: chartLabels,
  };

  const memoryHistory = {
    datasets: [
      {
        backgroundColor: "rgba(59, 130, 246, 0.14)",
        borderColor: "rgba(59, 130, 246, 0.95)",
        borderWidth: 2,
        data: (dashboard?.history ?? []).map((point) => point.mem_total),
        fill: true,
        label: "Memory",
        pointRadius: 0,
        tension: 0.32,
      },
    ],
    labels: chartLabels,
  };

  const networkHistory = {
    datasets: [
      {
        backgroundColor: "rgba(99, 102, 241, 0.14)",
        borderColor: "rgba(99, 102, 241, 0.95)",
        borderWidth: 2,
        data: (dashboard?.history ?? []).map((point) => point.net_recv_total),
        fill: true,
        label: "Receive",
        pointRadius: 0,
        tension: 0.32,
      },
      {
        backgroundColor: "rgba(244, 114, 182, 0.10)",
        borderColor: "rgba(244, 114, 182, 0.92)",
        borderWidth: 2,
        data: (dashboard?.history ?? []).map((point) => point.net_sent_total),
        fill: true,
        label: "Send",
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

  if (!dashboard || !settingsDraft) {
    return (
      <main className="mx-auto flex min-h-screen max-w-7xl items-center justify-center px-6 py-16">
        <div className="glass-panel max-w-xl p-10 text-center">
          <div className="text-sm uppercase tracking-[0.24em]" style={{ color: "var(--text-secondary)" }}>
            PulseGuard
          </div>
          <h1 className="mt-3 text-4xl font-semibold">Preparing monitor workspace</h1>
          <p className="mt-4 text-base" style={{ color: "var(--text-secondary)" }}>
            Creating the dashboard, loading settings, and opening the local SQLite archive.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl flex-col gap-8 px-5 py-6 lg:px-8">
      <section className="glass-panel overflow-hidden p-6 lg:p-8">
        <div className="grid gap-8 lg:grid-cols-[1.65fr,0.95fr]">
          <div>
            <div className="text-sm uppercase tracking-[0.24em]" style={{ color: "var(--text-secondary)" }}>
              Watch the pulse
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-4">
              <h1 className="text-4xl font-semibold tracking-tight lg:text-5xl">PulseGuard</h1>
              <StatusBadge status={dashboard.status} />
            </div>
            <p className="mt-4 max-w-3xl text-base leading-7" style={{ color: "var(--text-secondary)" }}>
              Lightweight per-process system monitoring with Rust collection, SQLite retention, and a
              native-feeling Tauri dashboard. Close the window if you want; the sampler can keep running.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                className="control-chip border-transparent bg-accent-500/90 text-white hover:bg-accent-600"
                disabled={busyAction !== null}
                onClick={() => void applyMonitorMode("running")}
                type="button"
              >
                Start Monitoring
              </button>
              <button
                className="control-chip"
                disabled={busyAction !== null}
                onClick={() => void applyMonitorMode("paused")}
                type="button"
              >
                Pause
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
          </div>

          <div className="soft-panel flex flex-col gap-4 p-5">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm uppercase tracking-[0.18em]" style={{ color: "var(--text-secondary)" }}>
                Current status
              </span>
              <span className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
                {formatTimestamp(dashboard.snapshot.timestamp)}
              </span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <MetricCard
                detail="Active processes in the latest sample"
                label="Processes"
                value={String(dashboard.snapshot.totals.process_count)}
              />
              <MetricCard
                detail="Aggregated CPU across collected rows"
                label="CPU"
                value={formatPercent(dashboard.snapshot.totals.cpu_total)}
              />
              <MetricCard
                detail="Resident memory share"
                label="Memory"
                value={formatPercent(dashboard.snapshot.totals.mem_total)}
              />
              <MetricCard
                detail="Per-sample internet delta"
                label="Network"
                value={`${formatBytes(dashboard.snapshot.totals.net_recv_total)} ↓ / ${formatBytes(dashboard.snapshot.totals.net_sent_total)} ↑`}
              />
            </div>
          </div>
        </div>
      </section>

      {error ? (
        <section className="glass-panel border-rose-300/40 p-4 text-sm text-rose-700 dark:text-rose-200">
          {error}
        </section>
      ) : null}

      {message ? (
        <section className="glass-panel border-accent-300/40 p-4 text-sm text-accent-700 dark:text-accent-200">
          {message}
        </section>
      ) : null}

      <section className="grid gap-6 xl:grid-cols-[1.45fr,0.85fr]">
        <div className="glass-panel p-5 lg:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-2xl font-semibold">Activity curves</h2>
              <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
                Historical totals sampled from the local SQLite archive.
              </p>
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
          <div className="mt-6 grid gap-4 xl:grid-cols-3">
            <div className="soft-panel h-72 p-4">
              <div className="h-full">
                <Line data={cpuHistory} options={buildChartOptions("CPU %")} />
              </div>
            </div>
            <div className="soft-panel h-72 p-4">
              <div className="h-full">
                <Line data={memoryHistory} options={buildChartOptions("Memory %")} />
              </div>
            </div>
            <div className="soft-panel h-72 p-4">
              <div className="h-full">
                <Line data={networkHistory} options={buildChartOptions("Bytes")} />
              </div>
            </div>
          </div>
        </div>

        <div className="glass-panel p-5 lg:p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-2xl font-semibold">Settings</h2>
              <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
                Changes are stored in the config directory and applied to the monitor loop.
              </p>
            </div>
            <button
              className="control-chip border-transparent bg-accent-500/90 text-white hover:bg-accent-600"
              disabled={busyAction !== null}
              onClick={() => void saveSettings()}
              type="button"
            >
              Save
            </button>
          </div>
          <div className="mt-6 grid gap-4">
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
            <label className="soft-panel flex items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
              <span>Start monitoring on launch</span>
              <input
                checked={settingsDraft.auto_start}
                className="h-5 w-5 rounded border"
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
            <div className="soft-panel p-4 text-sm" style={{ color: "var(--text-secondary)" }}>
              <div className="font-semibold" style={{ color: "var(--text-primary)" }}>
                Export folder
              </div>
              <div className="mt-1 break-all">{dashboard.export_dir}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="glass-panel p-5 lg:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-2xl font-semibold">Process table</h2>
            <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
              Search by name or PID, sort by any metric, and filter out low-signal CPU entries.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:w-[30rem]">
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
        <div className="mt-5 overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-y-2 text-left text-sm">
            <thead>
              <tr style={{ color: "var(--text-secondary)" }}>
                {[
                  ["name", "Process"],
                  ["cpu_percent", "CPU"],
                  ["mem_percent", "Memory"],
                  ["disk_read_bytes", "Disk Read"],
                  ["disk_write_bytes", "Disk Write"],
                  ["net_recv_bytes", "Net Recv"],
                  ["net_sent_bytes", "Net Sent"],
                ].map(([key, label]) => (
                  <th key={key} className="px-3 py-2 font-medium">
                    <button
                      className="flex items-center gap-2"
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
                <tr key={`${row.pid}-${row.timestamp}`} className="soft-panel">
                  <td className="rounded-l-2xl px-3 py-3">
                    <div className="font-semibold">{row.name}</div>
                    <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
                      PID {row.pid}
                    </div>
                  </td>
                  <td className="px-3 py-3">{formatPercent(row.cpu_percent)}</td>
                  <td className="px-3 py-3">{formatPercent(row.mem_percent)}</td>
                  <td className="px-3 py-3">{formatBytes(row.disk_read_bytes)}</td>
                  <td className="px-3 py-3">{formatBytes(row.disk_write_bytes)}</td>
                  <td className="px-3 py-3">{formatBytes(row.net_recv_bytes)}</td>
                  <td className="rounded-r-2xl px-3 py-3">{formatBytes(row.net_sent_bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredRows.length === 0 ? (
            <div className="soft-panel mt-4 px-4 py-6 text-center text-sm" style={{ color: "var(--text-secondary)" }}>
              No processes matched the current filter.
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
