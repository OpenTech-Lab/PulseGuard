import { invoke } from "@tauri-apps/api/core";
import type {
  DashboardPayload,
  ExportFormat,
  ExportResult,
  HistoryPoint,
  MonitorMode,
  MonitorSettings,
  RichProcess,
} from "../types";

export function getDashboard(hours = 24) {
  return invoke<DashboardPayload>("get_dashboard", { hours });
}

export function getHistory(hours = 24) {
  return invoke<HistoryPoint[]>("get_history", { hours });
}

export function setMonitorMode(mode: MonitorMode) {
  return invoke<MonitorMode>("set_monitor_mode", { mode });
}

export function updateSettings(settings: MonitorSettings) {
  return invoke<MonitorSettings>("update_settings", { settings });
}

export function exportSamples(format: ExportFormat, hours = 24) {
  return invoke<ExportResult>("export_samples", { format, hours });
}

export function getProcesses() {
  return invoke<RichProcess[]>("get_processes");
}

