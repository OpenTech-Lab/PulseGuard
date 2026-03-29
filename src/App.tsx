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
import type { ChartData, ChartOptions } from "chart.js";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { startTransition, useDeferredValue, useEffect, useEffectEvent, useState } from "react";
import type { CSSProperties } from "react";
import { Line } from "react-chartjs-2";
import { exportSamples, getDashboard, getProcesses, setMonitorMode, updateSettings } from "./lib/api";
import type {
  DashboardPayload,
  DashboardSnapshot,
  ExportFormat,
  HistoryPoint,
  MonitorMode,
  MonitorSettings,
  ProcessSample,
  RichProcess,
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

const appWindow = getCurrentWindow();

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
  | "disk_write_bytes";

type TabKey = "activity" | "settings" | "processes";
type ResearchResource = "cpu" | "memory" | "network" | "processes";
type ResearchSortKey = "name" | "cpu_percent" | "mem_bytes" | "disk_read_bytes" | "disk_write_bytes" | "run_time_secs" | "start_time";
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

function formatSharePercent(value: number, maxValue: number) {
  if (maxValue <= 0) {
    return "0%";
  }

  return `${numberFormat.format((value / maxValue) * 100)}%`;
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

function formatRunTime(seconds: number) {
  if (seconds === 0) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function formatUnixTimestamp(seconds: number) {
  if (seconds === 0) return "—";
  return new Date(seconds * 1000).toLocaleString();
}

function buildRainColumn(index: number) {
  return Array.from({ length: 18 }, (_, line) => matrixGlyphs[(index * 2 + line) % matrixGlyphs.length]).join("\n");
}

function historyPointFromSnapshot(snapshot: DashboardSnapshot): HistoryPoint | null {
  if (!snapshot.timestamp) {
    return null;
  }

  return {
    timestamp: snapshot.timestamp,
    cpu_total: snapshot.totals.cpu_total,
    mem_total_bytes: snapshot.totals.mem_total_bytes,
    disk_read_total: snapshot.totals.disk_read_total,
    disk_write_total: snapshot.totals.disk_write_total,
    net_recv_total: snapshot.totals.net_recv_total,
    net_sent_total: snapshot.totals.net_sent_total,
    process_count: snapshot.totals.process_count,
  };
}

function mergeHistoryPoint(history: HistoryPoint[], nextPoint: HistoryPoint, rangeHours: number) {
  const cutoff = Date.now() - rangeHours * 60 * 60 * 1000;
  const nextHistory = history
    .filter((point) => point.timestamp !== nextPoint.timestamp)
    .filter((point) => {
      const timestamp = Date.parse(point.timestamp);
      return Number.isNaN(timestamp) || timestamp >= cutoff;
    });

  nextHistory.push(nextPoint);
  nextHistory.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  return nextHistory;
}

function buildChartOptions(
  label: string,
  valueMode: "bytes" | "gigabytes" | "percent" | "count" = "percent",
  maxValue?: number,
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
                  : valueMode === "count"
                    ? String(Math.round(value))
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
        max: maxValue,
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

function WindowChrome() {
  return (
    <header className="window-chrome glass-panel">
      <div
        className="window-drag-area"
        onMouseDown={(event) => {
          if (event.button !== 0) {
            return;
          }

          void appWindow.startDragging();
        }}
      >
        <div className="window-title">PulseGuard</div>
        <div className="window-subtitle">Monitor Console</div>
      </div>
      <div className="window-actions">
        <button
          aria-label="Minimize window"
          className="window-action"
          onClick={() => {
            void appWindow.minimize();
          }}
          type="button"
        >
          <span aria-hidden="true">_</span>
        </button>
        <button
          aria-label="Toggle maximize window"
          className="window-action"
          onClick={() => {
            void appWindow.toggleMaximize();
          }}
          type="button"
        >
          <span aria-hidden="true">[]</span>
        </button>
        <button
          aria-label="Close window"
          className="window-action window-action-close"
          onClick={() => {
            void appWindow.close();
          }}
          type="button"
        >
          <span aria-hidden="true">X</span>
        </button>
      </div>
    </header>
  );
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
  inlineDetail,
  detail,
  title,
  onResearch,
}: {
  label: string;
  value: string;
  inlineDetail?: string;
  detail?: string;
  title?: string;
  onResearch?: () => void;
}) {
  return (
    <div className="soft-panel animate-pulse-enter matrix-card p-4">
      {(title !== undefined || onResearch !== undefined) ? (
        <div className="mb-2 flex items-center justify-between">
          {title !== undefined ? (
            <span className="text-[10px] font-bold uppercase tracking-[0.25em]" style={{ color: "var(--accent)" }}>
              {title}
            </span>
          ) : <span />}
          {onResearch !== undefined ? (
            <button
              onClick={onResearch}
              title="Research"
              type="button"
              className="rounded p-0.5 opacity-40 transition-opacity hover:opacity-100"
              style={{ color: "var(--text-secondary)" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="11" y1="8" x2="11" y2="14" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="text-[11px] uppercase tracking-[0.3em]" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="font-mono text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
          {value}
        </div>
        {inlineDetail ? (
          <div
            className="shrink-0 font-mono text-xs uppercase tracking-[0.18em]"
            style={{ color: "var(--text-secondary)" }}
          >
            {inlineDetail}
          </div>
        ) : null}
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

const researchTitles: Record<ResearchResource, string> = {
  cpu: "CPU Load Analysis",
  memory: "Memory Bank Analysis",
  network: "Net Flux Analysis",
  processes: "Process Registry",
};

function ResourceResearchPage({
  resource,
  processes,
  loading,
  chartData,
  chartOptions,
  onClose,
}: {
  resource: ResearchResource;
  processes: RichProcess[];
  loading: boolean;
  chartData: ChartData<"line">;
  chartOptions: ChartOptions<"line">;
  onClose: () => void;
}) {
  const defaultSortKey: ResearchSortKey = resource === "memory" ? "mem_bytes" : "cpu_percent";
  const [sortKey, setSortKey] = useState<ResearchSortKey>(defaultSortKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function toggleResearchSort(key: ResearchSortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }

  const sorted = [...processes].sort((a, b) => {
    const aVal = a[sortKey];
    const bVal = b[sortKey];
    if (typeof aVal === "string" && typeof bVal === "string") {
      return sortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    const na = Number(aVal ?? 0);
    const nb = Number(bVal ?? 0);
    return sortDir === "asc" ? na - nb : nb - na;
  });

  const sortColumns: Array<[ResearchSortKey, string]> = [
    ["name", "Process"],
    ["cpu_percent", "CPU %"],
    ["mem_bytes", "Memory (GB)"],
    ["disk_read_bytes", "Disk R"],
    ["disk_write_bytes", "Disk W"],
    ["run_time_secs", "Running"],
    ["start_time", "Started"],
  ];

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden" style={{ background: "rgba(0,0,0,0.82)" }}>
      <MatrixBackdrop />
      {/* Header */}
      <div className="glass-panel relative z-10 mx-4 mt-4 flex shrink-0 items-center gap-3 p-3">
        <button className="control-chip flex items-center gap-1" onClick={onClose} type="button">
          ← Back
        </button>
        <h2 className="section-title text-lg font-semibold">{researchTitles[resource]}</h2>
      </div>
      {/* Chart on top, Table below */}
      <div className="relative z-10 flex flex-1 flex-col gap-3 overflow-hidden p-4">
        {/* Chart: fixed height row */}
        <div className="soft-panel chart-shell h-44 shrink-0 overflow-hidden p-3">
          <Line data={chartData} options={chartOptions} />
        </div>
        {/* Table: fills remaining height, scrolls internally */}
        <div className="glass-panel flex min-w-0 flex-1 flex-col overflow-hidden p-3">
          <div className="mb-2 shrink-0 text-[10px] uppercase tracking-[0.28em]" style={{ color: "var(--text-muted)" }}>
            {loading ? "Loading…" : `${sorted.length} processes`}
          </div>
          {loading ? (
            <div className="flex flex-1 items-center justify-center text-sm" style={{ color: "var(--text-secondary)" }}>
              Loading…
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="border-separate border-spacing-y-1.5 text-left text-xs">
                <thead className="sticky top-0" style={{ background: "rgba(0,0,0,0.96)" }}>
                  <tr style={{ color: "var(--text-muted)" }}>
                    {sortColumns.map(([key, label]) => (
                      <th key={key} className="whitespace-nowrap px-3 py-2 font-medium">
                        <button
                          className="flex items-center gap-1 uppercase tracking-[0.18em]"
                          onClick={() => toggleResearchSort(key)}
                          type="button"
                        >
                          {label}
                          {sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                        </button>
                      </th>
                    ))}
                    <th className="whitespace-nowrap px-3 py-2 font-medium uppercase tracking-[0.18em]">Parent</th>
                    <th className="whitespace-nowrap px-3 py-2 font-medium uppercase tracking-[0.18em]">Path</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((proc) => (
                    <tr key={proc.pid} className="soft-panel process-row">
                      <td className="whitespace-nowrap rounded-l-2xl px-3 py-2">
                        <div className="font-semibold uppercase tracking-[0.08em]">{proc.name}</div>
                        <div className="font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>
                          PID {proc.pid}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono">{formatPercent(proc.cpu_percent)}</td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono">{formatGigabytes(proc.mem_bytes)}</td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono">{formatBytes(proc.disk_read_bytes)}</td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono">{formatBytes(proc.disk_write_bytes)}</td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono">{formatRunTime(proc.run_time_secs)}</td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono">{formatUnixTimestamp(proc.start_time)}</td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono" style={{ color: "var(--text-muted)" }}>
                        {proc.parent_pid ?? "—"}
                      </td>
                      <td className="rounded-r-2xl px-3 py-2">
                        <div className="flex items-center gap-1">
                          <span
                            className="block w-40 truncate font-mono text-[10px]"
                            style={{ color: "var(--text-secondary)" }}
                            title={proc.exe_path}
                          >
                            {proc.exe_path || "—"}
                          </span>
                          {proc.exe_path ? (
                            <button
                              className="shrink-0 opacity-40 hover:opacity-100 transition-opacity"
                              onClick={() => void navigator.clipboard.writeText(proc.exe_path)}
                              title="Copy full path"
                              type="button"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-secondary)" }}>
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                              </svg>
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sorted.length === 0 ? (
                <div className="soft-panel mt-4 px-4 py-6 text-center text-xs" style={{ color: "var(--text-secondary)" }}>
                  No process data. Start monitoring to collect data.
                </div>
              ) : null}
            </div>
          )}
        </div>
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
  const [researchResource, setResearchResource] = useState<ResearchResource | null>(null);
  const [richProcesses, setRichProcesses] = useState<RichProcess[]>([]);
  const [richProcessesLoading, setRichProcessesLoading] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      setIsResizing(true);
      clearTimeout(timer);
      timer = setTimeout(() => setIsResizing(false), 300);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(timer);
    };
  }, []);

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

  useEffect(() => {
    void hydrate(historyHours);
  }, [historyHours]);

  const applySample = useEffectEvent((snapshot: DashboardSnapshot) => {
    const nextHistoryPoint = historyPointFromSnapshot(snapshot);

    startTransition(() => {
      setDashboard((current) =>
        current
          ? {
              ...current,
              snapshot,
              history: nextHistoryPoint
                ? mergeHistoryPoint(current.history, nextHistoryPoint, historyHours)
                : current.history,
            }
          : current,
      );
    });
  });

  const applyStatus = useEffectEvent((status: MonitorMode) => {
    startTransition(() => {
      setDashboard((current) =>
        current
          ? {
              ...current,
              status,
            }
          : current,
      );
    });
  });

  useEffect(() => {
    let unlistenSample: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;

    const register = async () => {
      unlistenSample = await listen<DashboardSnapshot>("monitor://sample", (event) => {
        applySample(event.payload);
      });

      unlistenStatus = await listen<StatusPayload>("monitor://status", (event) => {
        applyStatus(event.payload.status);
      });
    };

    void register();

    return () => {
      unlistenSample?.();
      unlistenStatus?.();
    };
  }, []);

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

  async function openResearch(resource: ResearchResource) {
    setResearchResource(resource);
    setRichProcesses([]);
    setRichProcessesLoading(true);
    try {
      const procs = await getProcesses();
      setRichProcesses(procs);
    } catch {
      // table will show empty state
    } finally {
      setRichProcessesLoading(false);
    }
  }

  const rows = dashboard?.snapshot.processes ?? [];
  const filteredRows = [...rows]
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

  const processCountHistory = {
    datasets: [
      {
        backgroundColor: "rgba(80, 255, 118, 0.14)",
        borderColor: "rgba(118, 255, 145, 0.96)",
        borderWidth: 2,
        data: (dashboard?.history ?? []).map((point) => point.process_count),
        fill: true,
        label: "PROC_COUNT",
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
  const cpuChartMax = Math.max(100, dashboard.snapshot.totals.cpu_capacity_percent);
  const memoryChartMax = Math.max(BYTES_PER_GB, dashboard.snapshot.totals.memory_capacity_bytes);
  const cpuUsageShare = formatSharePercent(
    dashboard.snapshot.totals.cpu_total,
    dashboard.snapshot.totals.cpu_capacity_percent,
  );
  const memoryUsageShare = formatSharePercent(
    dashboard.snapshot.totals.mem_total_bytes,
    dashboard.snapshot.totals.memory_capacity_bytes,
  );

  return (
    <main className="matrix-shell mx-auto flex h-screen max-w-6xl flex-col overflow-hidden">
      <MatrixBackdrop />
      <WindowChrome />
      <div
          className="flex-1 overflow-x-hidden overflow-y-auto px-1 lg:px-2"
          style={isResizing ? { pointerEvents: "none" } : undefined}
          onMouseDown={(e) => {
            const target = e.target as HTMLElement;
            if (!target.closest("button, input, select, textarea, a, [role='button']")) {
              e.preventDefault();
            }
          }}
        >
      <section className="glass-panel overflow-hidden p-2 lg:p-3">
        <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
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

        <div className="grid gap-2">
          <div>
            <div className="hero-kicker text-[11px] uppercase tracking-[0.32em]" style={{ color: "var(--text-secondary)" }}>
              Zion Node 01 / Live Monitor
            </div>
            <div className="hero-readout mt-1 grid gap-1 sm:grid-cols-3">
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
            <div className="soft-panel mt-1 p-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-mono text-[11px]" style={{ color: "var(--text-secondary)" }}>
                  archive://pulseguard.db
                </span>
                <span className="text-[11px] uppercase tracking-[0.28em]" style={{ color: "var(--text-muted)" }}>
                  Signal Matrix
                </span>
              </div>
              <div className="grid gap-2 lg:grid-cols-4">
                <MetricCard
                  title="Processes"
                  label="Process Count"
                  value={String(dashboard.snapshot.totals.process_count)}
                  onResearch={() => void openResearch("processes")}
                />
                <MetricCard
                  title="CPU Load"
                  label="CPU Load"
                  value={formatPercent(dashboard.snapshot.totals.cpu_total)}
                  inlineDetail={`(${cpuUsageShare})`}
                  detail={`${formatPercent(dashboard.snapshot.totals.cpu_capacity_percent)} max`}
                  onResearch={() => void openResearch("cpu")}
                />
                <MetricCard
                  title="Memory Bank"
                  label="Memory Bank"
                  value={formatGigabytes(dashboard.snapshot.totals.mem_total_bytes)}
                  inlineDetail={`(${memoryUsageShare})`}
                  detail={`${formatGigabytes(dashboard.snapshot.totals.memory_capacity_bytes)} max`}
                  onResearch={() => void openResearch("memory")}
                />
                <MetricCard
                  title="Network I/O"
                  label="Net Flux"
                  value={`${formatCompactBytes(dashboard.snapshot.totals.net_recv_total)}↓ / ${formatCompactBytes(dashboard.snapshot.totals.net_sent_total)}↑`}
                  onResearch={() => void openResearch("network")}
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
        <section className="glass-panel min-w-0 overflow-hidden p-2 lg:p-3">
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
          <div className="mt-2 grid min-w-0 gap-2 md:grid-cols-2">
            <div className="grid min-w-0 gap-2">
              <div className="soft-panel chart-shell h-44 min-w-0 overflow-hidden p-2">
                <div className="h-full min-w-0">
                  <Line data={cpuHistory} options={buildChartOptions("CPU %", "percent", cpuChartMax)} />
                </div>
              </div>
              <div className="soft-panel chart-shell h-44 min-w-0 overflow-hidden p-2">
                <div className="h-full min-w-0">
                  <Line
                    data={memoryHistory}
                    options={buildChartOptions("Memory GB", "gigabytes", memoryChartMax)}
                  />
                </div>
              </div>
            </div>
            <div className="grid min-w-0 gap-2">
              <div className="soft-panel chart-shell h-44 min-w-0 overflow-hidden p-2">
                <div className="h-full min-w-0">
                  <Line data={networkHistory} options={buildChartOptions("Net I/O", "bytes")} />
                </div>
              </div>
              <div className="soft-panel chart-shell h-44 min-w-0 overflow-hidden p-2">
                <div className="h-full min-w-0">
                  <Line data={diskHistory} options={buildChartOptions("Disk I/O", "bytes")} />
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {activeTab === "settings" ? (
        <section className="glass-panel p-2 lg:p-3">
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
          <div className="mt-2 grid gap-2">
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
        <section className="glass-panel p-2 lg:p-3">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
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
            <table className="border-separate border-spacing-y-2 text-left text-sm">
              <thead>
                <tr style={{ color: "var(--text-muted)" }}>
                  {[
                    ["name", "Process"],
                    ["cpu_percent", "CPU %"],
                    ["mem_bytes", "Memory (GB)"],
                    ["disk_read_bytes", "Disk Read"],
                    ["disk_write_bytes", "Disk Write"],
                  ].map(([key, label]) => (
                    <th key={key} className="whitespace-nowrap px-3 py-2 font-medium">
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
                    <td className="whitespace-nowrap rounded-l-2xl px-3 py-2.5">
                      <div className="font-semibold uppercase tracking-[0.08em]">{row.name}</div>
                      <div className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
                        PID {row.pid}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono">{formatPercent(row.cpu_percent)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono">{formatGigabytes(row.mem_bytes)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono">{formatBytes(row.disk_read_bytes)}</td>
                    <td className="whitespace-nowrap rounded-r-2xl px-3 py-2.5 font-mono">{formatBytes(row.disk_write_bytes)}</td>
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
      </div>
      {researchResource !== null ? (
        <ResourceResearchPage
          resource={researchResource}
          processes={richProcesses}
          loading={richProcessesLoading}
          chartData={
            researchResource === "cpu"
              ? (cpuHistory as ChartData<"line">)
              : researchResource === "memory"
                ? (memoryHistory as ChartData<"line">)
                : researchResource === "network"
                  ? (networkHistory as ChartData<"line">)
                  : (processCountHistory as ChartData<"line">)
          }
          chartOptions={
            researchResource === "cpu"
              ? buildChartOptions("CPU %", "percent", cpuChartMax)
              : researchResource === "memory"
                ? buildChartOptions("Memory GB", "gigabytes", memoryChartMax)
                : researchResource === "network"
                  ? buildChartOptions("Net I/O", "bytes")
                  : buildChartOptions("Proc Count", "count")
          }
          onClose={() => setResearchResource(null)}
        />
      ) : null}
    </main>
  );
}
