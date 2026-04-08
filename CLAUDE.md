# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LumaSync** is a tray-first desktop application (Tauri 2 + React 19) that synchronizes WS2812B LED strips with screen content and controls Philips Hue entertainment areas. Package name: `lumasync`, identifier: `com.lumasync.app`.

## Commands

```bash
# Development
yarn tauri dev          # Full app with hot reload (primary dev command)
yarn dev                # Vite dev server only (web, no Tauri)

# Type checking & linting
yarn typecheck          # TypeScript type check (no emit)
yarn lint               # Alias for typecheck
yarn check:rust         # cargo check on Rust code
yarn check:all          # JS + Rust + shell contract checks

# Build
yarn build              # TypeScript + Vite production build
yarn tauri build        # Build distributable binaries

# Tests
yarn vitest run         # Run frontend unit tests once
yarn vitest             # Watch mode

# Validation
yarn verify:shell-contracts   # Validate shell contract compatibility
```

## Architecture

### Layer Structure

```
Frontend (React/TS)  →  Tauri Commands (Rust)  →  Device Layer (Serial/HTTP)
```

- **Frontend** (`src/`): React 19, TypeScript strict, Tailwind CSS 4, i18next
- **Tauri Runtime** (`src-tauri/src/`): Rust 2021 edition, tray, window state, auto-updates
- **Device Layer**: Serial port (USB microcontrollers at 115200 baud) + Philips Hue CLIP v2 API

### Contract-First Design

All frontend–backend communication is defined in `src/shared/contracts/` **before** implementation:

- `device.ts` — Serial port commands and status codes
- `hue.ts` — Hue bridge commands, streaming states
- `shell.ts` — Tray menu IDs, section IDs, persisted state shape
- `display.ts` — Display enumeration

The `scripts/verify/phase01-shell-contracts.mjs` script validates that Rust handlers match frontend contract definitions. Run `yarn verify:shell-contracts` after modifying contracts or Rust command handlers.

### Feature Modules (`src/features/`)

Each feature follows a consistent internal structure:
- `ui/` — React components
- `state/` — State machine logic and hooks
- `model/` — Domain types and contracts
- `*Api.ts` — Tauri `invoke()` bridge

Key modules:
| Module | Purpose |
|--------|---------|
| `device` | USB controller discovery, connection health |
| `calibration` | LED layout editor, display mapping, test patterns |
| `mode` | Lighting mode state machine (Off/Ambilight/Solid) |
| `settings` | Multi-tab settings UI |
| `hue` | Hue bridge pairing, entertainment area, streaming |
| `tray` | Tray menu state sync |
| `updater` | Auto-update modal |
| `persistence` | Tauri plugin-store facade |

### Rust Command Modules (`src-tauri/src/commands/`)

| File | Commands |
|------|---------|
| `device_connection.rs` | `list_serial_ports`, `connect_serial_port`, `get_serial_connection_status`, `run_serial_health_check` |
| `hue_onboarding.rs` | `discover_hue_bridges`, `pair_hue_bridge`, `validate_hue_credentials`, `list_hue_entertainment_areas` |
| `hue_stream_lifecycle.rs` | `start_hue_stream`, `stop_hue_stream`, `set_hue_solid_color`, `get_hue_stream_status` |
| `lighting_mode.rs` | `set_lighting_mode`, `stop_lighting`, `get_lighting_mode_status` |
| `calibration.rs` | `start_calibration_test_pattern`, `list_displays`, `open_display_overlay` |
| `runtime_telemetry.rs` | `get_runtime_telemetry` |

### State Persistence

Tauri `plugin-store` persists state to `~/.config/lumasync/app.json`. The `shellStore.ts` facade wraps all read/write operations. Stored keys follow the shape defined in `src/shared/contracts/shell.ts`.

### Auto-Update

GitHub Releases with minisign verification. The updater checks on startup and surfaces `UpdateModal.tsx` if a newer version exists. Release artifacts must include a `latest.json` endpoint.

## Debugging: Live Log Analysis

When a bug cannot be reproduced or diagnosed from code alone, run the app and observe runtime logs:

```bash
# Kill any running instance, then start fresh
pkill -f "target/debug/lumasync" 2>/dev/null; pkill -f "yarn tauri dev" 2>/dev/null; sleep 2
yarn tauri dev 2>&1 &
sleep <seconds> && echo "--- timeout ---"
```

- Rust logs (`log::info!`, `log::warn!`) appear in terminal stdout. Frontend `console.log` does NOT appear in terminal — it goes to WebView devtools only.
- To trace frontend→backend flow, add temporary `log::info!` calls in Rust command handlers.
- Each Rust log line appears **twice** (dual log sinks) — this is normal, not duplicate execution.
- Use `timeout` parameter (in ms) on the Bash tool to capture enough log output.
- After diagnosing, remove temporary debug logs before committing.

Key log patterns to watch for:
- `[apply_mode_change]` — lighting mode activation
- `[ambilight-worker]` — screen capture worker lifecycle
- `DTLS entertainment stream established` — Hue streaming connected
- `HUE_STREAM_NOT_READY_ACTIVE_STREAMER` — bridge has stale session
- `AMBILIGHT_CAPTURE_PERMISSION_DENIED` — macOS screen recording permission missing

## Key Constraints

- **macOS private API** is enabled (`macos-private-api: true`) for fullscreen calibration overlays across all displays.
- Hue streaming interval: minimum 50ms (20 Hz) — do not exceed this or the bridge will throttle.
- Supported USB chip IDs: CH340 (0x1A86:0x7523), FTDI (0x0403:0x6001).
- Window size: 900×620 (min 720×480).
