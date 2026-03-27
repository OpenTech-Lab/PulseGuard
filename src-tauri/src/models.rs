use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MonitorMode {
    Running,
    Paused,
    #[default]
    Stopped,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MonitorSettings {
    pub interval_secs: u32,
    pub retention_days: u32,
    pub auto_start: bool,
}

impl Default for MonitorSettings {
    fn default() -> Self {
        Self {
            interval_secs: 10,
            retention_days: 30,
            auto_start: false,
        }
    }
}

impl MonitorSettings {
    pub fn sanitized(mut self) -> Self {
        self.interval_secs = self.interval_secs.clamp(3, 300);
        self.retention_days = self.retention_days.clamp(1, 365);
        self
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProcessSample {
    pub timestamp: String,
    pub pid: i64,
    pub name: String,
    pub cpu_percent: f64,
    pub mem_percent: f64,
    pub disk_read_bytes: u64,
    pub disk_write_bytes: u64,
    pub net_recv_bytes: u64,
    pub net_sent_bytes: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct SampleTotals {
    pub cpu_total: f64,
    pub mem_total: f64,
    pub disk_read_total: u64,
    pub disk_write_total: u64,
    pub net_recv_total: u64,
    pub net_sent_total: u64,
    pub process_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DashboardSnapshot {
    pub timestamp: Option<String>,
    pub processes: Vec<ProcessSample>,
    pub totals: SampleTotals,
}

impl DashboardSnapshot {
    pub fn empty() -> Self {
        Self {
            timestamp: None,
            processes: Vec::new(),
            totals: SampleTotals::default(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HistoryPoint {
    pub timestamp: String,
    pub cpu_total: f64,
    pub mem_total: f64,
    pub net_recv_total: u64,
    pub net_sent_total: u64,
    pub process_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DashboardPayload {
    pub status: MonitorMode,
    pub settings: MonitorSettings,
    pub snapshot: DashboardSnapshot,
    pub history: Vec<HistoryPoint>,
    pub export_dir: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExportResult {
    pub path: String,
    pub format: ExportFormat,
    pub rows: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StatusPayload {
    pub status: MonitorMode,
}
