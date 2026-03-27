export type MonitorMode = "running" | "paused" | "stopped";
export type ExportFormat = "csv" | "json";

export interface ProcessSample {
  timestamp: string;
  pid: number;
  name: string;
  cpu_percent: number;
  mem_percent: number;
  disk_read_bytes: number;
  disk_write_bytes: number;
  net_recv_bytes: number;
  net_sent_bytes: number;
}

export interface SampleTotals {
  cpu_total: number;
  mem_total: number;
  disk_read_total: number;
  disk_write_total: number;
  net_recv_total: number;
  net_sent_total: number;
  process_count: number;
}

export interface DashboardSnapshot {
  timestamp: string | null;
  processes: ProcessSample[];
  totals: SampleTotals;
}

export interface HistoryPoint {
  timestamp: string;
  cpu_total: number;
  mem_total: number;
  disk_read_total: number;
  disk_write_total: number;
  net_recv_total: number;
  net_sent_total: number;
  process_count: number;
}

export interface MonitorSettings {
  interval_secs: number;
  retention_days: number;
  auto_start: boolean;
}

export interface DashboardPayload {
  status: MonitorMode;
  settings: MonitorSettings;
  snapshot: DashboardSnapshot;
  history: HistoryPoint[];
  export_dir: string;
}

export interface ExportResult {
  path: string;
  format: ExportFormat;
  rows: number;
}

export interface StatusPayload {
  status: MonitorMode;
}
