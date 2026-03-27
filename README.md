# PulseGuard

PulseGuard is a lightweight Linux desktop monitor built with Tauri, Rust, React, TypeScript, Tailwind, Chart.js, and SQLite.

It records per-process CPU, memory, disk I/O, and best-effort internet I/O deltas into `~/.config/pulseguard/pulseguard.db`, then renders live tables and historical charts from that local archive.

## Features

- Per-process CPU, memory, disk read/write, and internet receive/send deltas
- Configurable sampling interval and retention window
- SQLite-backed history with CSV and JSON export
- Searchable, sortable dashboard with live charts
- Tray icon with Open, Pause / Resume, and Quit controls
- `.deb` and `.AppImage` packaging through Tauri

## Project Layout

- `src/`: React frontend
- `src-tauri/`: Rust backend, monitoring thread, SQLite access, tray setup, packaging config
- `docs/01.mvp.md`: MVP spec
- `scripts/bump-version.sh`: release version bump, tag, commit, and push helper
- `.github/workflows/release.yml`: GitHub Release bundle build workflow

## Local Development

Install Linux prerequisites:

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  curl \
  libssl-dev \
  patchelf
```

Install dependencies and run the desktop app:

```bash
npm install
npm run tauri dev
```

Build release bundles:

```bash
npm run tauri build -- --bundles deb,appimage
```

## Release Flow

Cut a new version:

```bash
./scripts/bump-version.sh 0.1.0
```

That script updates the frontend version, the Rust package version, the Tauri bundle version, release notes under `scripts/version/`, creates a release commit, tags it as `v<version>`, and pushes the branch and tag unless you disable those steps with flags.

