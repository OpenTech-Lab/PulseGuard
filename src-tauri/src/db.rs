use std::fmt::Write as FmtWrite;
use std::fs;
use std::path::Path;

use chrono::{Duration, Utc};
use rusqlite::{params, Connection};

use crate::error::AppResult;
use crate::models::{ExportFormat, ExportResult, HistoryPoint, ProcessSample};

pub fn init_db(db_path: &Path) -> AppResult<()> {
    let connection = Connection::open(db_path)?;
    connection.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS process_stats (
            id                INTEGER PRIMARY KEY,
            timestamp         TEXT NOT NULL,
            pid               INTEGER NOT NULL,
            name              TEXT NOT NULL,
            cpu_percent       REAL,
            mem_percent       REAL,
            mem_bytes         INTEGER DEFAULT 0,
            mem_used_bytes    INTEGER DEFAULT 0,
            memory_capacity_bytes INTEGER DEFAULT 0,
            disk_read_bytes   INTEGER DEFAULT 0,
            disk_write_bytes  INTEGER DEFAULT 0,
            net_recv_bytes    INTEGER DEFAULT 0,
            net_sent_bytes    INTEGER DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_timestamp ON process_stats(timestamp);
        CREATE INDEX IF NOT EXISTS idx_name ON process_stats(name);
        CREATE INDEX IF NOT EXISTS idx_pid ON process_stats(pid);
        "#,
    )?;
    ensure_column(&connection, "process_stats", "mem_bytes", "INTEGER DEFAULT 0")?;
    ensure_column(
        &connection,
        "process_stats",
        "mem_used_bytes",
        "INTEGER DEFAULT 0",
    )?;
    ensure_column(
        &connection,
        "process_stats",
        "memory_capacity_bytes",
        "INTEGER DEFAULT 0",
    )?;
    Ok(())
}

pub fn insert_samples(
    db_path: &Path,
    samples: &[ProcessSample],
    mem_used_bytes: u64,
    memory_capacity_bytes: u64,
    retention_days: u32,
) -> AppResult<()> {
    let mut connection = Connection::open(db_path)?;
    let transaction = connection.transaction()?;

    let cutoff = (Utc::now() - Duration::days(i64::from(retention_days))).to_rfc3339();
    transaction.execute(
        "DELETE FROM process_stats WHERE timestamp < ?1",
        params![cutoff],
    )?;

    if !samples.is_empty() {
        let mut statement = transaction.prepare(
            r#"
            INSERT INTO process_stats (
                timestamp,
                pid,
                name,
                cpu_percent,
                mem_percent,
                mem_bytes,
                mem_used_bytes,
                memory_capacity_bytes,
                disk_read_bytes,
                disk_write_bytes,
                net_recv_bytes,
                net_sent_bytes
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            "#,
        )?;

        for sample in samples {
            statement.execute(params![
                sample.timestamp,
                sample.pid,
                sample.name,
                sample.cpu_percent,
                0.0_f64,
                sample.mem_bytes,
                mem_used_bytes,
                memory_capacity_bytes,
                sample.disk_read_bytes,
                sample.disk_write_bytes,
                sample.net_recv_bytes,
                sample.net_sent_bytes,
            ])?;
        }
    }

    transaction.commit()?;
    Ok(())
}

pub fn load_history(db_path: &Path, hours: u32) -> AppResult<Vec<HistoryPoint>> {
    let connection = Connection::open(db_path)?;
    let cutoff = (Utc::now() - Duration::hours(i64::from(hours.max(1)))).to_rfc3339();

    let mut statement = connection.prepare(
        r#"
        SELECT
            timestamp,
            ROUND(COALESCE(SUM(cpu_percent), 0), 2) AS cpu_total,
            COALESCE(MAX(mem_used_bytes), 0) AS mem_total_bytes,
            COALESCE(SUM(disk_read_bytes), 0) AS disk_read_total,
            COALESCE(SUM(disk_write_bytes), 0) AS disk_write_total,
            COALESCE(SUM(net_recv_bytes), 0) AS net_recv_total,
            COALESCE(SUM(net_sent_bytes), 0) AS net_sent_total,
            COUNT(*) AS process_count
        FROM process_stats
        WHERE timestamp >= ?1
        GROUP BY timestamp
        ORDER BY timestamp ASC
        "#,
    )?;

    let rows = statement.query_map(params![cutoff], |row| {
        Ok(HistoryPoint {
            timestamp: row.get(0)?,
            cpu_total: row.get(1)?,
            mem_total_bytes: row.get(2)?,
            disk_read_total: row.get(3)?,
            disk_write_total: row.get(4)?,
            net_recv_total: row.get(5)?,
            net_sent_total: row.get(6)?,
            process_count: row.get::<_, i64>(7)? as usize,
        })
    })?;

    let mut history = Vec::new();
    for row in rows {
        history.push(row?);
    }
    Ok(history)
}

pub fn export_samples(
    db_path: &Path,
    export_dir: &Path,
    format: ExportFormat,
    hours: u32,
) -> AppResult<ExportResult> {
    fs::create_dir_all(export_dir)?;
    let rows = load_rows(db_path, hours)?;
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S");

    let (path, contents) = match format {
        ExportFormat::Csv => {
            let mut csv = String::from(
                "timestamp,pid,name,cpu_percent,mem_bytes,disk_read_bytes,disk_write_bytes,net_recv_bytes,net_sent_bytes\n",
            );
            for row in &rows {
                let _ = writeln!(
                    csv,
                    "{},{},{},{:.2},{},{},{},{},{}",
                    csv_escape(&row.timestamp),
                    row.pid,
                    csv_escape(&row.name),
                    row.cpu_percent,
                    row.mem_bytes,
                    row.disk_read_bytes,
                    row.disk_write_bytes,
                    row.net_recv_bytes,
                    row.net_sent_bytes
                );
            }
            (export_dir.join(format!("pulseguard-{timestamp}.csv")), csv)
        }
        ExportFormat::Json => (
            export_dir.join(format!("pulseguard-{timestamp}.json")),
            format!("{}\n", serde_json::to_string_pretty(&rows)?),
        ),
    };

    fs::write(&path, contents)?;

    Ok(ExportResult {
        path: path.to_string_lossy().into_owned(),
        format,
        rows: rows.len(),
    })
}

fn load_rows(db_path: &Path, hours: u32) -> AppResult<Vec<ProcessSample>> {
    let connection = Connection::open(db_path)?;
    let cutoff = (Utc::now() - Duration::hours(i64::from(hours.max(1)))).to_rfc3339();

    let mut statement = connection.prepare(
        r#"
        SELECT
            timestamp,
            pid,
            name,
            cpu_percent,
            mem_bytes,
            disk_read_bytes,
            disk_write_bytes,
            net_recv_bytes,
            net_sent_bytes
        FROM process_stats
        WHERE timestamp >= ?1
        ORDER BY timestamp DESC, cpu_percent DESC, mem_bytes DESC
        "#,
    )?;

    let rows = statement.query_map(params![cutoff], |row| {
        Ok(ProcessSample {
            timestamp: row.get(0)?,
            pid: row.get(1)?,
            name: row.get(2)?,
            cpu_percent: row.get(3)?,
            mem_bytes: row.get(4)?,
            disk_read_bytes: row.get(5)?,
            disk_write_bytes: row.get(6)?,
            net_recv_bytes: row.get(7)?,
            net_sent_bytes: row.get(8)?,
        })
    })?;

    let mut samples = Vec::new();
    for row in rows {
        samples.push(row?);
    }
    Ok(samples)
}

fn csv_escape(value: &str) -> String {
    if value.contains([',', '"', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> AppResult<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }

    connection.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
        [],
    )?;
    Ok(())
}
