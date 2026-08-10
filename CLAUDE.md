# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LumaSync** is a native desktop application (Tauri 2 + React 19) that mirrors the screen to WS2812B LED strips and Philips Hue entertainment areas in real time, with per-edge room-map calibration and fully local processing. Package name: `lumasync`, identifier: `com.lumasync.app`.

## Planning

Local planning artifacts live under `.planning/` which is **gitignored and never committed, unignored, or distributed**. It is the maintainer's private workspace; it exists for session continuity, not for publication. Assume collaborators, CI, and sandboxed agents do not see this directory.

- `.planning/ROADMAP.md` — master roadmap: shipped versions, active milestones (v1.4 / v1.5 / v2.0), domain-grouped backlog, rejected ideas (DNA-conflicts), and known limitations. Every milestone item references the research artefact that justifies it.
- `.planning/competitive-research/` — 2026-04-22 competitive analysis of 11 ambient-lighting products. Layout: `inventory/` (LumaSync today), `competitors/` (per-product), `comparison/<domain>-vs-lumasync.md` (per-domain gap list with priorities). The per-domain comparison md's are the primary source for roadmap gap items.
- Other subdirectories (`led-preview-experience/`, etc.) — scoped research or design notes for specific features.

When the user asks about a feature, milestone, or gap ID (e.g. "v1.4", "USB per-LED sampling", "G2"), read `.planning/ROADMAP.md` first; then open the referenced comparison md for full context before proposing an implementation plan. **Never propose committing `.planning/` content, removing it from `.gitignore`, or otherwise distributing it.**

## Agent Routing

This project uses specialist agents in `.claude/agents/`. They are the primary authority for their domains. The main assistant is an **orchestrator**, not an inline worker.

### Routing rules

For any non-trivial task, **spawn the relevant specialist agent(s) instead of working inline.** "Non-trivial" means anything that:

- plans or designs work (roadmap, phase, feature, refactor)
- edits code beyond a one-line fix or rename
- touches `src-tauri/`, `src/features/`, `src/shared/contracts/`, `.github/workflows/`, `CHANGELOG.md`, `SECURITY.md`, version files
- spans more than one domain (Hue + UI, contract + Rust, etc.)
- proposes adding a new dependency, partnership, or integration
- prepares a release or a PR

For multi-domain work, **spawn relevant agents in parallel**, then synthesize their outputs. Never serialize what can run concurrently.

### Inline work is allowed only for

- One-line clarifications or factual questions answered from a single file read
- Typo fixes, identifier renames, pure string edits
- Conversational back-and-forth during the **design discussion phase** (user preference — see `ls-design-language` and user memory `feedback_uiux_approach.md`), before any code is written

If in doubt, spawn the agent. The token cost of a redundant spawn is trivial compared to the cost of missing an expert-flagged blind spot.

### Agent map

| Trigger | Agent |
|---|---|
| Planning a phase / milestone / multi-domain feature | Spawn the relevant domain agents in parallel, then synthesize |
| Tauri command / status-code / contract change (FIRST, before any implementation) | `contract-architect` |
| Hue CLIP v2 / DTLS / entertainment streaming / bridge / 403 re-pair | `hue-expert` |
| USB serial / WS2812B / Adalight / WLED / OpenRGB / firmware / `LedSink` | `device-serial-expert` |
| Rust backend / Tauri config / capture pipeline / tray / platform / CI | `tauri-expert` |
| React components / Tailwind / amber Rev 07 design language / compact mode / a11y / i18n | `ui-ux-expert` |
| New tests / test strategy / coverage gaps / Vitest / cargo test | `test-expert` |
| PR review / release readiness / CHANGELOG / Conventional Commits / license / secrets audit | `opensource-guardian` |
| "X.Y.Z atıyorum" / "release hazırla" / "new version" | `release-manager` |

### Runtime debugging — invoke `debug-runtime` BEFORE spawning agents

When the user reports a runtime symptom that cannot be diagnosed from code
alone — UI hangs, crashes, mode transitions misbehaving, capture failures,
Hue/USB anomalies, shutdown deadlocks — invoke the `debug-runtime` skill
first via the Skill tool (or run `/debug-runtime "<problem>"` if the user
typed it). The skill restarts a clean dev session, captures both frontend
(via `tauri-plugin-log` `attachConsole` bridge) and backend logs into a
single file, runs the validation suite, and either applies a small inline
fix or hands the captured `/tmp/lumasync-debug-window.log` excerpt to the
right specialist with file:line citations. Skipping this step and
spawning a specialist on hypothesis means the agent re-discovers what the
runtime would have proven in 30 seconds.

Skip the skill only when the bug is already proven by a stack trace or a
failing test in this conversation — re-running the app for evidence we
already have wastes a warm-up cycle.

## Commands

```bash
# Development
pnpm tauri dev          # Full app with hot reload (primary dev command)
pnpm dev                # Vite dev server only (web, no Tauri)

# Type checking & linting
pnpm typecheck          # TypeScript type check (no emit)
pnpm lint               # Alias for typecheck
pnpm check:rust         # cargo check on Rust code
pnpm check:all          # JS + Rust + shell contract checks

# Build
pnpm build              # TypeScript + Vite production build
pnpm tauri build        # Build distributable binaries

# Tests
pnpm vitest run         # Run frontend unit tests once
pnpm vitest             # Watch mode

# Validation
pnpm verify:shell-contracts   # Validate shell contract compatibility

# Rust gates (mirrored in CI — run from src-tauri/)
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features -- --test-threads=1   # single-threaded: see note below
cargo audit                                     # advisory scan; ignores live in .cargo/audit.toml
```

CI passes `--test-threads=1` to `cargo test`. It is **not** required: the
worker-touching `lighting_mode` tests serialise themselves on a `WORKER_TEST_GUARD`
mutex shared by both test modules, so the suite passes at default parallelism.
The flag predates that guard and is now belt-and-braces. Reproduce CI exactly if
you are chasing a CI-only failure; otherwise plain `cargo test` is fine.

## Architecture

### Layer Structure

```
Frontend (React/TS)  →  Tauri Commands (Rust)  →  Device Layer (Serial/HTTP)
```

- **Frontend** (`src/`): React 19, TypeScript strict, Tailwind CSS 4, i18next
- **Tauri Runtime** (`src-tauri/src/`): Rust 2021 edition, tray, window state, auto-updates
- **Device Layer**: Serial port (USB microcontrollers at 115200 baud), WLED over UDP (DDP/WARLS), and the Philips Hue CLIP v2 API

### Contract-First Design

All frontend–backend communication is defined in `src/shared/contracts/` **before**
implementation. The directory is the source of truth — list it rather than
trusting any summary, including this one:

| File | Owns |
|---|---|
| `device.ts` | Serial commands + status codes, VID/PID support flags, firmware profile, LED chip type, `LedSinkConfig`, WLED UDP sink config + discovery |
| `hue.ts` | Bridge commands, pairing/auth status codes, streaming states, stream telemetry |
| `shell.ts` | Tray menu IDs, section IDs, `ShellState` persisted shape, `UI_MODE_SIZES` / `UI_MODE_MIN_SIZES`, keybind registry |
| `lighting.ts` | Lighting mode kinds and payloads |
| `calibration.ts` | LED calibration layout shapes |
| `display.ts` | Display enumeration and metadata |
| `roomMap.ts` | Room-map objects, Hue zones, channel positions |
| `platform.ts` | Notification + log-directory surface |

The `scripts/verify/phase01-shell-contracts.mjs` script validates that Rust handlers match frontend contract definitions. Run `pnpm verify:shell-contracts` after modifying contracts or Rust command handlers.

### Feature Modules (`src/features/`)

Each feature follows a consistent internal structure:
- `ui/` — React components
- `state/` — State machine logic and hooks
- `model/` — Domain types and contracts
- `*Api.ts` — Tauri `invoke()` bridge

Not every module uses all four; small ones are a flat file or two. Modules come
and go — `ls src/features/` is authoritative, the table below is orientation:

| Module | Purpose |
|--------|---------|
| `shell` | App chrome — TitleBar, StatusBar, window lifecycle, global keybinds, accent theme, `GlobalErrorBoundary` |
| `device` | USB controller discovery, connection health, WLED sink |
| `calibration` | LED layout editor, display mapping, test patterns |
| `mode` | Lighting mode state machine (Off/Ambilight/Solid) |
| `settings` | Section-routed settings UI (`sections/`, incl. `room-map/`, `control/`, `compact/`) |
| `onboarding` | First-run flow |
| `telemetry` | Runtime telemetry surfaces (FPS, Hue stream grid) |
| `tray` | Tray menu state sync |
| `updater` | Auto-update modal |
| `persistence` | Tauri plugin-store facade + store migrations |
| `i18n` | i18next bootstrap, language policy, locale-parity test |

Hue has no `src/features/hue/` module — its UI lives in
`settings/sections/DeviceSection.tsx` and `HueChannelMapPanel.tsx`, and its
contract in `src/shared/contracts/hue.ts`.

### Rust Command Modules (`src-tauri/src/commands/`)

Roughly twenty files plus the `hue/` and `room_map/` subdirectories — too many
to mirror accurately here. **List the directory and grep for
`#[tauri::command]`**; `src-tauri/src/lib.rs`'s `generate_handler![]` block is
the authoritative registration list. Orientation only:

| Area | Files |
|---|---|
| Serial / LED output | `device_connection.rs`, `device_handshake.rs`, `led_output.rs`, `led_sink.rs`, `led_calibration.rs` |
| Network LED | `wled_discovery.rs`, `wled_sink.rs` |
| Hue | `hue_onboarding.rs`, `hue_http.rs`, `hue_intensity.rs`, `hue/` (commands, dtls, frame, sender, reconnect, retry, state_store, credential_store) |
| Capture + lighting | `ambilight_capture.rs`, `lighting_mode.rs`, `runtime_quality.rs`, `runtime_telemetry.rs` |
| Calibration / preview | `calibration.rs`, `test_pattern.rs`, `led_preview.rs` |
| Room map | `room_map/` (save_load, hue_zone) |
| Platform | `platform.rs`, `notifications.rs` |

`hue_stream_lifecycle.rs` is a re-export shim only — the implementation moved
under `commands::hue::*`. Import paths still resolve through it; do not add new
code there.

### State Persistence

Tauri `plugin-store` writes `shell-state.json` into the app data directory —
on macOS `~/Library/Application Support/com.lumasync.app/shell-state.json`
(Windows `%APPDATA%\com.lumasync.app\`, Linux `~/.local/share/com.lumasync.app/`).
The store key is `SHELL_STORE_KEY` in `src/shared/contracts/shell.ts`; the Rust
side reads the same file via `app.path().app_data_dir()`. The `shellStore.ts`
facade wraps all frontend read/write operations, and `migrations.ts` handles
shape changes. Stored keys follow `ShellState` in `shell.ts`.

Hue PSK credentials do **not** live here — they are in the OS keychain via
`commands/hue/credential_store.rs` (macOS Keychain / Windows CredMan / Linux
Secret Service).

### Auto-Update

GitHub Releases with minisign verification. The updater checks on startup and surfaces `UpdateModal.tsx` if a newer version exists. Release artifacts must include a `latest.json` endpoint.

## Code Style

### TypeScript + React

- TypeScript strict-safe code; avoid `any` unless unavoidable.
- Prefer explicit domain interfaces/types for API payloads and state.
- Use `const` by default; `let` only when reassignment is needed.
- Keep components focused; move non-UI logic into feature `state/` or `model/` files.
- Functional components and hooks only. Side effects in `useEffect` with accurate deps.
- Use `useCallback` for handlers passed to children.
- Fire-and-forget async: `void someAsyncCall()`.
- Imports: external packages first, then internal. Use `import type` where practical.
- Components: PascalCase. Hooks: `useXxx`. Helpers: camelCase. Constants: UPPER_SNAKE_CASE.

### Rust / Tauri

- Command payloads: strongly typed `struct`s with `#[derive(Serialize)]`.
- Use `#[serde(rename_all = "camelCase")]` for frontend compatibility.
- Return stable machine-readable status codes plus human-readable messages.
- Keep command handlers focused; extract helpers for mapping/validation.
- Follow `rustfmt` defaults.

### Error Handling

- Never swallow failures silently.
- TS: `try/catch` around async IO/runtime command boundaries.
- Log with contextual prefixes (`[LumaSync] ...`).
- Rust: return coded error context via status objects or `Result<_, String>`.
- Prefer explicit fallback values for invalid external input.

### Testing

- **Test execution is permitted in this project.** The global "do not run tests unless explicitly asked" rule does NOT apply to LumaSync — `pnpm vitest run`, `cargo test`, `pnpm verify:shell-contracts` are part of the normal verification loop and may be invoked by Claude or any agent without asking first when validating a change.
- Tests live in a `__tests__/` subfolder next to the code under test: `foo.ts` → `__tests__/foo.test.ts`.
- Use Testing Library + Vitest globals (`describe`, `it`, `expect`, `vi`).
- Mock Tauri/plugin boundaries for deterministic frontend tests.
- Rust: focused behavior tests with clear scenario names.
- Only add/adjust tests for changed behavior, not unrelated areas.

### Contracts & i18n

- `src/shared/contracts/**` is the source of truth for cross-layer data shapes.
- Preserve command/status code semantics; avoid ad-hoc code strings.
- Keep i18n keys stable and scoped by feature. Update EN + TR locale files consistently.

## Verification Flow

Run after any change, lightest checks first:

1. `pnpm typecheck`
2. `pnpm vitest run <changed-test-or-folder>`
3. `pnpm verify:shell-contracts` (if contracts/commands touched)
4. `pnpm check:rust` (if Rust touched)
5. `cargo fmt --all -- --check` + `cargo clippy --all-targets --all-features -- -D warnings` + `cargo test --all-features -- --test-threads=1` (if Rust touched — CI enforces all three, clippy at deny level)
6. `pnpm build` (integration confidence)

## Debugging: Live Log Analysis

Prefer the `debug-runtime` skill — it encodes the clean-restart, capture, and
classify sequence below. The manual path:

```bash
# Kill any running instance, clear the leaked single-instance socket, start fresh
pkill -9 -f "tauri dev" 2>/dev/null; pkill -9 -f "target/debug/lumasync" 2>/dev/null; sleep 2
rm -f /tmp/com_lumasync_app_si.sock
pnpm tauri dev > /tmp/lumasync-debug-stdout.log 2>&1 &
```

- **One log file holds everything.** `src/main.tsx` wraps `console.log/info/warn/error`
  and forwards them into `tauri-plugin-log`, so frontend output lands in the same
  sink as Rust's `log::info!`/`log::warn!`. On macOS that file is
  `~/Library/Logs/com.lumasync.app/lumasync-dev.log` (dev) /
  `LumaSync.log` (release). Read the file first; terminal stdout only helps for
  crashes before the sink initialises.
- Frontend lines carry the `[LumaSync]` prefix by convention.
- Two sinks are configured (Stdout + LogDir), so a line seen in both places is
  not duplicate execution.
- Dev logging is `Debug` for `lumasync_lib` and `Info` for the `webview` target;
  release is `Info` globally. Log rotation: 5 MB per file, `KeepAll` in dev,
  `KeepOne` in release.
- After diagnosing, remove temporary debug logs before committing.

Key log patterns to watch for:
- `[apply_mode_change]` — lighting mode activation
- `[ambilight-worker]` — screen capture worker lifecycle
- `[shutdown]` — quit path; expect `cleanup complete, exiting`, not `watchdog fired`
- `DTLS entertainment stream established` — Hue streaming connected
- `HUE_STREAM_NOT_READY_ACTIVE_STREAMER` — bridge has stale session
- `AMBILIGHT_CAPTURE_PERMISSION_DENIED` — macOS screen recording permission missing

## Release Workflow

Triggered by "X.Y.Z atacağım" / "yeni versiyon" / "release hazırla" → spawn
`release-manager`, which owns the full procedure. The `ls-ci-release-standards`
skill is the single source for CI steps, the readiness checklist, and how
publication works. Do not re-derive either here.

What must stay true regardless of who does the work:

- **Three version locations move in lockstep**: `src-tauri/Cargo.toml`, `package.json`, `SECURITY.md`. Then `cargo check` to refresh `Cargo.lock`. `tauri.conf.json` has no version field — it inherits from Cargo.toml.
- **CHANGELOG is a reader-facing release note, not an audit log.** High-level summaries grouped by theme; the commit history is the audit log.
  - Good: `i18n: localize remaining static labels across Device, Updater, RoomMap, and StatusBar (EN + TR in sync)`
  - Avoid: every translation key, every renamed path, every internal refactor, every dependency point release
  - Group dependency bumps one line per ecosystem (Rust / frontend / GitHub Actions); call one out individually only for a **major version** or user-visible impact
  - Omit purely internal changes unless they affect contributors or downstream consumers
  - If a bullet reads like a commit message, collapse it into the nearest theme
  - No duplicate `## [X.Y.Z]` headings — `release.yml` extracts notes with `awk` and stops at the first match
- **Work lands on `main` through pull requests.** Branch protection requires four checks: `Build and Check (ubuntu-24.04)`, `Build and Check (macos-latest)`, `Build and Check (windows-latest)`, `Analyze (javascript-typescript)`. Renaming a workflow job renames its status context — a required context no job produces blocks every PR until an admin overrides it.
- **Tagging publishes in two stages.** The build matrix uploads into a *draft* (`releaseDraft: true`) so the updater feed never sees a platform-incomplete `latest.json`; a `publish` job then asserts all four platform keys before undrafting. A `-` in the tag (e.g. `-rc.1`) marks it prerelease.
- **Do NOT commit, tag, or push unless the user explicitly asks.**

## Key Constraints

- **macOS private API** is enabled (`macos-private-api: true`) for fullscreen calibration overlays across all displays.
- Hue streaming interval: minimum 50 ms (20 Hz) — `HUE_SENDER_MIN_INTERVAL_MS` in `src-tauri/src/commands/hue/sender.rs`. Going faster makes the bridge throttle and drop the stream.
- USB serial is gated by a **9-entry VID/PID allowlist** (`SUPPORTED_USB_DEVICE_ALLOWLIST` in `src-tauri/src/commands/device_connection.rs`): CH340, FTDI FT232R, CP2102, Arduino Uno R3+, Arduino Uno (early), PL2303, CH341, CP2104, FT232H. All ports are enumerated with `isSupported`; connect is blocked with `PORT_UNSUPPORTED` for the rest. Never hardcode the list elsewhere — read the constant.
- Serial link: 115 200 baud, 8N1.
- Window size: per-mode (see `UI_MODE_SIZES` / `UI_MODE_MIN_SIZES` in `src/shared/contracts/shell.ts`): full 900×620 (min 800×560), compact 320×480 (min 300×420).
- `MACOSX_DEPLOYMENT_TARGET` is pinned to `12.3` at workflow level in both CI and release. Lowering it reintroduces the 1.5.2 dyld launch crash (issue #115).
