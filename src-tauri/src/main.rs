#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod error;
mod models;
mod monitor;
mod storage;

use std::sync::{Arc, RwLock};

use models::{
    DashboardPayload, ExportFormat, ExportResult, HistoryPoint, MonitorMode, MonitorSettings,
};
use monitor::MonitorController;
use storage::AppPaths;
use tauri::menu::MenuBuilder;
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, State, WindowEvent};

struct AppState {
    monitor: MonitorController,
    paths: AppPaths,
    settings: Arc<RwLock<MonitorSettings>>,
}

#[tauri::command]
fn get_dashboard(
    hours: Option<u32>,
    state: State<'_, AppState>,
) -> Result<DashboardPayload, String> {
    let hours = hours.unwrap_or(24).max(1);
    let history =
        db::load_history(&state.paths.db_path, hours).map_err(|error| error.to_string())?;

    Ok(DashboardPayload {
        status: state.monitor.mode(),
        settings: state
            .settings
            .read()
            .map_err(|_| "Failed to read settings".to_string())?
            .clone(),
        snapshot: state.monitor.snapshot(),
        history,
        export_dir: state.paths.export_dir.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn get_history(
    hours: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<HistoryPoint>, String> {
    db::load_history(&state.paths.db_path, hours.unwrap_or(24).max(1))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_monitor_mode(mode: MonitorMode, state: State<'_, AppState>) -> MonitorMode {
    state.monitor.set_mode(mode)
}

#[tauri::command]
fn update_settings(
    settings: MonitorSettings,
    state: State<'_, AppState>,
) -> Result<MonitorSettings, String> {
    let sanitized = settings.sanitized();
    storage::save_settings(&state.paths.settings_path, &sanitized)
        .map_err(|error| error.to_string())?;

    {
        let mut current = state
            .settings
            .write()
            .map_err(|_| "Failed to write settings".to_string())?;
        *current = sanitized.clone();
    }

    state.monitor.notify_settings_changed();
    Ok(sanitized)
}

#[tauri::command]
fn export_samples(
    format: ExportFormat,
    hours: Option<u32>,
    state: State<'_, AppState>,
) -> Result<ExportResult, String> {
    db::export_samples(
        &state.paths.db_path,
        &state.paths.export_dir,
        format,
        hours.unwrap_or(24).max(1),
    )
    .map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| -> Result<(), Box<dyn std::error::Error>> {
            let paths = storage::prepare_paths()?;
            let settings = storage::load_settings(&paths.settings_path)?.sanitized();
            storage::save_settings(&paths.settings_path, &settings)?;
            db::init_db(&paths.db_path)?;

            let shared_settings = Arc::new(RwLock::new(settings.clone()));
            let initial_mode = if settings.auto_start {
                MonitorMode::Running
            } else {
                MonitorMode::Stopped
            };
            let monitor = MonitorController::new(
                app.handle().clone(),
                paths.db_path.clone(),
                shared_settings.clone(),
                initial_mode,
            )?;

            app.manage(AppState {
                monitor: monitor.clone(),
                paths: paths.clone(),
                settings: shared_settings,
            });

            build_tray(app, monitor)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if state.monitor.allow_exit() {
                    return;
                }

                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_dashboard,
            get_history,
            set_monitor_mode,
            update_settings,
            export_samples
        ])
        .run(tauri::generate_context!())
        .expect("failed to run PulseGuard");
}

fn build_tray(app: &mut tauri::App, monitor: MonitorController) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("tray-open", "Open PulseGuard")
        .text("tray-toggle", "Pause / Resume")
        .separator()
        .text("tray-quit", "Quit")
        .build()?;

    let menu_monitor = monitor.clone();
    #[cfg(target_os = "linux")]
    let tray_builder = TrayIconBuilder::with_id("pulseguard-tray");

    #[cfg(not(target_os = "linux"))]
    let tray_builder = TrayIconBuilder::with_id("pulseguard-tray").icon(
        app.default_window_icon()
            .expect("missing default application icon")
            .clone(),
    );

    tray_builder
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "tray-open" => {
                let _ = show_main_window(app);
            }
            "tray-toggle" => {
                menu_monitor.toggle_pause_resume();
            }
            "tray-quit" => {
                menu_monitor.request_shutdown();
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    let _ = show_main_window(app.handle());
    Ok(())
}

fn show_main_window<R: tauri::Runtime, M: Manager<R>>(manager: &M) -> Result<(), tauri::Error> {
    if let Some(window) = manager.get_webview_window("main") {
        window.show()?;
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(())
}
