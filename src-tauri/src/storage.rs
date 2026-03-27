use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::models::MonitorSettings;

#[derive(Clone, Debug)]
pub struct AppPaths {
    pub db_path: PathBuf,
    pub settings_path: PathBuf,
    pub export_dir: PathBuf,
}

pub fn prepare_paths() -> AppResult<AppPaths> {
    let base_dir = dirs::config_dir()
        .ok_or_else(|| AppError::Message("Unable to resolve the user config directory".into()))?
        .join("pulseguard");
    let export_dir = base_dir.join("exports");
    fs::create_dir_all(&export_dir)?;

    Ok(AppPaths {
        db_path: base_dir.join("pulseguard.db"),
        settings_path: base_dir.join("settings.json"),
        export_dir,
    })
}

pub fn load_settings(path: &Path) -> AppResult<MonitorSettings> {
    if !path.exists() {
        let defaults = MonitorSettings::default();
        save_settings(path, &defaults)?;
        return Ok(defaults);
    }

    let raw = fs::read_to_string(path)?;
    let parsed: MonitorSettings = serde_json::from_str(&raw)?;
    Ok(parsed.sanitized())
}

pub fn save_settings(path: &Path, settings: &MonitorSettings) -> AppResult<()> {
    let contents = format!("{}\n", serde_json::to_string_pretty(settings)?);
    fs::write(path, contents)?;
    Ok(())
}
