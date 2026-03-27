use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::thread;
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use sysinfo::{Pid, ProcessesToUpdate, System, MINIMUM_CPU_UPDATE_INTERVAL};
use tauri::{AppHandle, Emitter};

use crate::db;
use crate::error::AppResult;
use crate::models::{
    DashboardSnapshot, MonitorMode, MonitorSettings, ProcessSample, SampleTotals, StatusPayload,
};

const SAMPLE_EVENT: &str = "monitor://sample";
const STATUS_EVENT: &str = "monitor://status";
const TRAY_ID: &str = "pulseguard-tray";
const BYTES_PER_GIB: f64 = 1024.0 * 1024.0 * 1024.0;

#[derive(Clone)]
pub struct MonitorController {
    inner: Arc<MonitorInner>,
}

struct MonitorInner {
    app: AppHandle,
    db_path: PathBuf,
    settings: Arc<RwLock<MonitorSettings>>,
    snapshot: RwLock<DashboardSnapshot>,
    mode: Mutex<MonitorMode>,
    cv: Condvar,
    shutdown: AtomicBool,
    allow_exit: AtomicBool,
}

#[derive(Clone, Copy, Default)]
struct NetCounters {
    recv_bytes: u64,
    sent_bytes: u64,
}

impl MonitorController {
    pub fn new(
        app: AppHandle,
        db_path: PathBuf,
        settings: Arc<RwLock<MonitorSettings>>,
        initial_mode: MonitorMode,
    ) -> AppResult<Self> {
        let inner = Arc::new(MonitorInner {
            app,
            db_path,
            settings,
            snapshot: RwLock::new(DashboardSnapshot::empty()),
            mode: Mutex::new(initial_mode),
            cv: Condvar::new(),
            shutdown: AtomicBool::new(false),
            allow_exit: AtomicBool::new(false),
        });

        let worker = inner.clone();
        thread::Builder::new()
            .name("pulseguard-monitor".into())
            .spawn(move || monitor_loop(worker))?;

        let controller = Self { inner };
        controller.emit_status(controller.mode());
        controller.update_tray_tooltip();
        Ok(controller)
    }

    pub fn mode(&self) -> MonitorMode {
        *self.inner.mode.lock().expect("monitor mode lock poisoned")
    }

    pub fn snapshot(&self) -> DashboardSnapshot {
        self.inner
            .snapshot
            .read()
            .expect("snapshot lock poisoned")
            .clone()
    }

    pub fn set_mode(&self, mode: MonitorMode) -> MonitorMode {
        {
            let mut current = self.inner.mode.lock().expect("monitor mode lock poisoned");
            *current = mode;
        }
        self.inner.cv.notify_all();
        self.emit_status(mode);
        self.update_tray_tooltip();
        mode
    }

    pub fn toggle_pause_resume(&self) -> MonitorMode {
        match self.mode() {
            MonitorMode::Running => self.set_mode(MonitorMode::Paused),
            MonitorMode::Paused | MonitorMode::Stopped => self.set_mode(MonitorMode::Running),
        }
    }

    pub fn notify_settings_changed(&self) {
        self.inner.cv.notify_all();
        self.update_tray_tooltip();
    }

    pub fn request_shutdown(&self) {
        self.inner.allow_exit.store(true, AtomicOrdering::SeqCst);
        self.inner.shutdown.store(true, AtomicOrdering::SeqCst);
        self.inner.cv.notify_all();
    }

    pub fn allow_exit(&self) -> bool {
        self.inner.allow_exit.load(AtomicOrdering::SeqCst)
    }

    fn emit_status(&self, status: MonitorMode) {
        let _ = self.inner.app.emit(STATUS_EVENT, StatusPayload { status });
    }

    fn update_tray_tooltip(&self) {
        update_tray_tooltip(&self.inner.app, self.mode(), &self.snapshot());
    }
}

fn monitor_loop(inner: Arc<MonitorInner>) {
    let mut system = System::new();
    let mut last_network = HashMap::<i64, NetCounters>::new();
    let mut warmup_needed = true;

    loop {
        if inner.shutdown.load(AtomicOrdering::SeqCst) {
            break;
        }

        let interval = {
            let mut mode_guard = inner.mode.lock().expect("monitor mode lock poisoned");
            while *mode_guard != MonitorMode::Running {
                if inner.shutdown.load(AtomicOrdering::SeqCst) {
                    return;
                }

                warmup_needed = true;
                if *mode_guard == MonitorMode::Stopped {
                    last_network.clear();
                    if let Ok(mut snapshot) = inner.snapshot.write() {
                        *snapshot = DashboardSnapshot::empty();
                    }
                    update_tray_tooltip(&inner.app, *mode_guard, &DashboardSnapshot::empty());
                }

                mode_guard = inner.cv.wait(mode_guard).expect("monitor condvar poisoned");
            }

            inner
                .settings
                .read()
                .expect("settings lock poisoned")
                .interval_secs
        };

        if warmup_needed {
            system.refresh_memory();
            system.refresh_processes(ProcessesToUpdate::All, true);
            thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
            warmup_needed = false;
        }

        let snapshot = collect_snapshot(&mut system, &mut last_network);
        let retention_days = inner
            .settings
            .read()
            .expect("settings lock poisoned")
            .retention_days;

        if let Err(error) = db::insert_samples(
            &inner.db_path,
            &snapshot.processes,
            snapshot.totals.mem_total_bytes,
            snapshot.totals.memory_capacity_bytes,
            retention_days,
        ) {
            eprintln!("pulseguard: failed to persist process samples: {error}");
        }

        if let Ok(mut current) = inner.snapshot.write() {
            *current = snapshot.clone();
        }

        let _ = inner.app.emit(SAMPLE_EVENT, snapshot.clone());
        update_tray_tooltip(&inner.app, MonitorMode::Running, &snapshot);

        let wait_duration = Duration::from_secs(u64::from(interval));
        let mode_guard = inner.mode.lock().expect("monitor mode lock poisoned");
        let (mode_guard, _) = inner
            .cv
            .wait_timeout_while(mode_guard, wait_duration, |mode| {
                *mode == MonitorMode::Running && !inner.shutdown.load(AtomicOrdering::SeqCst)
            })
            .expect("monitor wait_timeout_while poisoned");

        if *mode_guard != MonitorMode::Running {
            warmup_needed = true;
        }
    }
}

fn collect_snapshot(
    system: &mut System,
    last_network: &mut HashMap<i64, NetCounters>,
) -> DashboardSnapshot {
    system.refresh_memory();
    system.refresh_processes(ProcessesToUpdate::All, true);

    let timestamp = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let cpu_capacity_percent = logical_thread_count() as f64 * 100.0;
    let total_memory = system.total_memory().max(1);
    let used_memory = system.used_memory();
    let mut active_network = HashMap::new();
    let mut processes = Vec::new();
    let mut totals = SampleTotals {
        cpu_capacity_percent,
        mem_total_bytes: used_memory,
        memory_capacity_bytes: total_memory,
        ..SampleTotals::default()
    };

    for (pid, process) in system.processes() {
        let pid_value = pid_to_i64(*pid);
        let name = process.name().to_string_lossy().trim().to_owned();
        if name.is_empty() {
            continue;
        }

        let disk = process.disk_usage();
        let network = read_process_net_bytes(pid_value);
        let previous_network = last_network.get(&pid_value).copied().unwrap_or_default();
        let recv_delta = network
            .recv_bytes
            .saturating_sub(previous_network.recv_bytes);
        let sent_delta = network
            .sent_bytes
            .saturating_sub(previous_network.sent_bytes);
        active_network.insert(pid_value, network);

        let cpu_percent = round_metric(process.cpu_usage() as f64);
        let mem_bytes = process.memory();
        let sample = ProcessSample {
            timestamp: timestamp.clone(),
            pid: pid_value,
            name,
            cpu_percent,
            mem_bytes,
            disk_read_bytes: disk.read_bytes,
            disk_write_bytes: disk.written_bytes,
            net_recv_bytes: recv_delta,
            net_sent_bytes: sent_delta,
        };

        if !should_store_sample(&sample, total_memory) {
            continue;
        }

        totals.cpu_total += sample.cpu_percent;
        totals.disk_read_total += sample.disk_read_bytes;
        totals.disk_write_total += sample.disk_write_bytes;
        totals.net_recv_total += sample.net_recv_bytes;
        totals.net_sent_total += sample.net_sent_bytes;
        processes.push(sample);
    }

    totals.cpu_total = round_metric(totals.cpu_total);
    totals.process_count = processes.len();
    processes.sort_by(compare_samples);

    *last_network = active_network;

    DashboardSnapshot {
        timestamp: Some(timestamp),
        processes,
        totals,
    }
}

fn should_store_sample(sample: &ProcessSample, total_memory: u64) -> bool {
    sample.cpu_percent >= 0.1
        || sample.mem_bytes as f64 / total_memory as f64 >= 0.001
        || sample.disk_read_bytes > 0
        || sample.disk_write_bytes > 0
        || sample.net_recv_bytes > 0
        || sample.net_sent_bytes > 0
}

fn compare_samples(left: &ProcessSample, right: &ProcessSample) -> Ordering {
    sample_score(right)
        .partial_cmp(&sample_score(left))
        .unwrap_or(Ordering::Equal)
        .then_with(|| right.pid.cmp(&left.pid))
}

fn sample_score(sample: &ProcessSample) -> f64 {
    sample.cpu_percent * 6.0
        + (sample.mem_bytes as f64 / BYTES_PER_GIB) * 2.5
        + (sample.disk_read_bytes + sample.disk_write_bytes) as f64 / 1024.0
        + (sample.net_recv_bytes + sample.net_sent_bytes) as f64 / 1024.0
}

fn round_metric(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn pid_to_i64(pid: Pid) -> i64 {
    i64::from(pid.as_u32())
}

fn read_process_net_bytes(pid: i64) -> NetCounters {
    let path = format!("/proc/{pid}/net/dev");
    let Ok(contents) = fs::read_to_string(path) else {
        return NetCounters::default();
    };

    let mut counters = NetCounters::default();
    for line in contents.lines().skip(2) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let Some((interface_name, values)) = line.split_once(':') else {
            continue;
        };
        if interface_name.trim() == "lo" {
            continue;
        }

        let columns: Vec<&str> = values.split_whitespace().collect();
        if columns.len() < 16 {
            continue;
        }

        counters.recv_bytes += columns[0].parse::<u64>().unwrap_or(0);
        counters.sent_bytes += columns[8].parse::<u64>().unwrap_or(0);
    }

    counters
}

fn update_tray_tooltip(app: &AppHandle, mode: MonitorMode, snapshot: &DashboardSnapshot) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };

    let status = match mode {
        MonitorMode::Running => "running",
        MonitorMode::Paused => "paused",
        MonitorMode::Stopped => "stopped",
    };
    let timestamp = snapshot
        .timestamp
        .as_deref()
        .map(short_timestamp)
        .unwrap_or_else(|| "waiting".into());
    let tooltip = format!(
        "PulseGuard ({status})\nCPU: {:.1}% / {:.0}% | Mem: {} / {}\nNet: {} down / {} up\nLast sample: {timestamp}",
        snapshot.totals.cpu_total,
        snapshot.totals.cpu_capacity_percent,
        human_gigabytes(snapshot.totals.mem_total_bytes),
        human_gigabytes(snapshot.totals.memory_capacity_bytes),
        human_bytes(snapshot.totals.net_recv_total),
        human_bytes(snapshot.totals.net_sent_total),
    );
    let _ = tray.set_tooltip(Some(tooltip));
}

fn short_timestamp(value: &str) -> String {
    value
        .split('T')
        .nth(1)
        .map(|part| part.trim_end_matches('Z').to_owned())
        .unwrap_or_else(|| value.to_owned())
}

fn human_bytes(value: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut current = value as f64;
    let mut unit_index = 0;

    while current >= 1024.0 && unit_index < units.len() - 1 {
        current /= 1024.0;
        unit_index += 1;
    }

    format!("{current:.1} {}", units[unit_index])
}

fn human_gigabytes(value: u64) -> String {
    format!("{:.1} GB", value as f64 / BYTES_PER_GIB)
}

fn logical_thread_count() -> usize {
    std::thread::available_parallelism()
        .unwrap_or(NonZeroUsize::MIN)
        .get()
}
