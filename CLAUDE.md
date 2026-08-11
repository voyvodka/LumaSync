# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LumaSync** is a native desktop application (Tauri 2 + React 19) that mirrors the screen to WS2812B LED strips and Philips Hue entertainment areas in real time, with per-edge room-map calibration and fully local processing. Package name: `lumasync`, identifier: `com.lumasync.app`.

## Working documents

Local working documents live under `devdocs/`, excluded from git. **Never committed, unignored,
or distributed.** Assume collaborators, CI, and sandboxed agents do not see it.

| File | Answers |
|---|---|
| `devdocs/product/00-state.md` | Where things stand, what is open, standing assumptions. **Read first.** |
| `devdocs/product/01-brief.md` | Problem, audience, primary flow, success criterion, constraints |
| `devdocs/product/02-decisions.md` | Why it is built this way — each decision with what was rejected and what it cost |
| `devdocs/product/03-mvp.md` | What is in and out of the current push, and what is parked |
| `devdocs/product/04-roadmap.md` | The current push as increments; also the progress ledger |
| `devdocs/backlog.md` | Long-horizon feature backlog |
| `devdocs/research/` | Evidence with sources. Dated, and goes stale. |
| `devdocs/competitive-research/` | Per-product analysis of the ambient-lighting field |
| `devdocs/RFCs/` | Design notes for specific changes |

Read `00-state.md` before proposing any implementation plan, then check `02-decisions.md` —
several obvious-looking ideas are already settled there, with the reason and the accepted cost.

**Never reference a `devdocs/` path from committed source, commit messages, PRs, or release
notes.** These files exist on one machine; a pointer to them in a public file is a dead
reference for every reader, and the code comment is the easiest place to do it by accident.
Put the reasoning in the comment instead of a link to it.

## Deliberately not built

Decisions, not gaps. Reopening one is fine; doing it without knowing it was decided is not.
Reasons and accepted costs are in `devdocs/product/02-decisions.md`.

- **Daemon or headless mode** — answered instead by autostart plus a planned loopback HTTP/WS API
- **Any outbound telemetry, analytics SDK, or third-party crash reporting** — including the "privacy-first" ones. Any feedback path must be user-initiated, user-inspectable, and abortable.
- **Cloud scene gallery, AI scene generation, proprietary peripheral bridges** (Razer, Corsair), **subscription gating**, **full-screen welcome wizard**, **container and Pi-headless distribution**
- **The room map on the first-run path** — it is an advanced surface. First run must reach working ambient lighting without it.

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

### Standing maintenance duties

These hold in **every** session, not only planning ones. Nobody invokes a command to trigger them.

- **Judge the specialist output you receive.** A subagent's answer is a draft, not a verdict. If it reads thin, contradicts the code, or is shallower than the task deserved, say so plainly instead of passing it on — then offer to send a focused agent to verify or redo that specific part. Ask before spawning; do not fan out.
- **Keep the tooling current.** The agent and skill definitions under `.claude/`, dependency and toolchain updates, and newly available models all drift out of date silently. Raise it when noticed, in a sentence, rather than opening a project.
- **Watch runtime cost.** The capture-to-output path has a per-frame budget. Treat a regression in it as a defect, not a tuning matter.

Spend tokens in proportion to what is at stake. One targeted agent against a specific doubt beats a
broad re-review, and noticing out loud costs nothing at all.

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

`pnpm tauri dev` is the primary development command; `pnpm dev` runs the Vite server alone with no
Tauri runtime. Everything else is in `package.json` — read it there. The verification sequence is
below under **Verification Flow**; `cargo audit` ignores live in `.cargo/audit.toml`.

`cargo build` and `pnpm tauri build --debug` write **the same path**
(`src-tauri/target/debug/lumasync`) but produce different binaries. The cargo one
loads the frontend from the Vite dev server, so launching it without `pnpm dev`
running gives a blank window and `Could not connect to localhost:1420` in the Web
Inspector — an intact app with no content. Nothing about the path reveals which
one is there. Use `pnpm tauri dev`, or rebuild with `--debug --no-bundle` to embed
the frontend.

Two things about the test setup that cost real time to discover:

CI passes `--test-threads=1` to `cargo test`. It is **not** required: the
worker-touching `lighting_mode` tests serialise themselves on a `WORKER_TEST_GUARD`
mutex shared by both test modules, so the suite passes at default parallelism.
The flag predates that guard and is now belt-and-braces. Reproduce CI exactly if
you are chasing a CI-only failure; otherwise plain `cargo test` is fine.

`build.rs` embeds `windows-app-manifest.xml` into **every** linked target rather
than letting tauri-build attach it to the bin alone. Test binaries reference
comctl32 v6 through tauri's tray/menu stack, and without the manifest Windows
refuses to load them (`STATUS_ENTRYPOINT_NOT_FOUND`).

## Architecture

```
Frontend (React/TS)  →  Tauri Commands (Rust)  →  Device Layer (Serial/HTTP)
```

- **Frontend** (`src/`): React 19, TypeScript strict, Tailwind CSS 4, i18next
- **Tauri Runtime** (`src-tauri/src/`): Rust 2021 edition, tray, window state, auto-updates
- **Device Layer**: Serial port (USB microcontrollers at 115200 baud), WLED over UDP (DDP/WARLS), and the Philips Hue CLIP v2 API

### Contract-First Design

All frontend–backend communication is defined in `src/shared/contracts/` **before**
implementation. That directory is the source of truth; list it rather than working from any
summary. `scripts/verify/phase01-shell-contracts.mjs` checks that Rust handlers match the
frontend definitions — run `pnpm verify:shell-contracts` after touching either side.

A green verifier means every status code crossing the IPC boundary is *declared*, not that it is
*correct*. It is a drift guard, not a coverage score.

### Feature modules (`src/features/`)

Each module uses some of `ui/` (React components), `state/` (state machines and hooks),
`model/` (domain types), and `*Api.ts` (the `invoke()` bridge). Small ones are a flat file or two.
`ls src/features/` is the authoritative list.

Two things the directory listing will not tell you:

- **Hue has no feature module.** Its UI lives in `settings/sections/DeviceSection.tsx` and `HueChannelMapPanel.tsx`, and its contract in `src/shared/contracts/hue.ts`.
- **`onboarding` does not include the room map.** That editor is an advanced surface most users skip; first run must work without it.

### Rust command modules (`src-tauri/src/commands/`)

Around twenty files plus the `hue/` and `room_map/` subdirectories. Grep for
`#[tauri::command]`; the `generate_handler![]` block in `src-tauri/src/lib.rs` is the
authoritative registration list.

`hue_stream_lifecycle.rs` is a re-export shim only — the implementation moved under
`commands::hue::*`. Import paths still resolve through it; do not add new code there.

### State persistence

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

### Auto-update

GitHub Releases with minisign verification. The updater checks on startup and surfaces `UpdateModal.tsx` if a newer version exists. Release artifacts must include a `latest.json` endpoint.

## Code Style

The surrounding code is the style guide. What follows is only what a reader would not infer from it.

**Rust / Tauri.** Command payloads are typed `struct`s with `#[derive(Serialize)]` and
`#[serde(rename_all = "camelCase")]`. Return stable machine-readable status codes alongside the
human-readable message — never a bare string error, and never an ad-hoc code invented at the call
site.

**Error handling.** Never swallow a failure silently; an empty `catch {}` is a defect in this
project, not a shortcut. Log with the `[LumaSync]` prefix. In Rust return coded context via a
status object or `Result<_, String>`. Prefer an explicit fallback value for invalid external
input over a silent default.

**Contracts and i18n.** `src/shared/contracts/**` is the source of truth for cross-layer shapes;
preserve command and status-code semantics. i18n keys stay stable and scoped by feature, and
EN + TR move together — a locale-parity test enforces it.

**Testing.** **Test execution is permitted in this project** — the global "do not run tests
unless explicitly asked" rule does NOT apply here. `pnpm vitest run`, `cargo test`, and
`pnpm verify:shell-contracts` are part of the normal loop and may be run without asking. Tests
live in a `__tests__/` subfolder beside the code under test (`foo.ts` → `__tests__/foo.test.ts`),
never co-located. Mock the Tauri boundary for deterministic frontend tests. Only add or adjust
tests for changed behaviour.

## Verification Flow

Run after any change, lightest checks first:

1. `pnpm typecheck`
2. `pnpm vitest run <changed-test-or-folder>`
3. `pnpm verify:shell-contracts` (if contracts/commands touched)
4. `pnpm check:rust` (if Rust touched)
5. `cargo fmt --all -- --check` + `cargo clippy --all-targets --all-features -- -D warnings` + `cargo test -- --test-threads=1` (if Rust touched — CI enforces all three, clippy at deny level)
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
skill is the single source for CI steps, the readiness checklist, CHANGELOG style, and how
publication works. Do not re-derive any of it here.

**Patch bumps only.** Every release is a patch bump for the foreseeable future, whatever the change
contains. Do not classify the bump from the diff — the answer is always patch until the maintainer
says otherwise. A change that is genuinely breaking still ships under a patch number, so it must be
called out in the release notes in as many words.

**Green CI proves the debug binary starts, not the download.** `scripts/verify/launch-smoke.mjs`
builds and launches the debug binary on all three platforms and waits for a startup marker, so a
dead binary fails the build. The bundled `.dmg` / `.msi` / `.deb` / AppImage is still never
launched anywhere — and bundling is where signing, entitlements, and app layout enter. Do not
describe a release artefact as verified on the strength of a green CI run.

Four things must stay true regardless of who does the work:

- **Three version locations move in lockstep**: `src-tauri/Cargo.toml`, `package.json`, `SECURITY.md`. Then `cargo check` to refresh `Cargo.lock`. `tauri.conf.json` has no version field — it inherits from Cargo.toml.
- **No duplicate `## [X.Y.Z]` headings in CHANGELOG.md** — `release.yml` extracts notes with `awk` and stops at the first match.
- **Work lands on `main` through pull requests.** Branch protection requires four checks: `Build and Check (ubuntu-24.04)`, `Build and Check (macos-latest)`, `Build and Check (windows-latest)`, `Analyze (javascript-typescript)`. Renaming a workflow job renames its status context — a required context no job produces blocks every PR until an admin overrides it.
- **Tagging publishes in two stages.** The build matrix uploads into a *draft* (`releaseDraft: true`) so the updater feed never sees a platform-incomplete `latest.json`; a `publish` job then asserts all four platform keys before undrafting. A `-` in the tag (e.g. `-rc.1`) marks it prerelease.

**Do NOT commit, tag, or push unless the user explicitly asks.**

## Key Constraints

- **macOS private API** is enabled (`macos-private-api: true`) for fullscreen calibration overlays across all displays.
- Hue streaming interval: minimum 50 ms (20 Hz) — `HUE_SENDER_MIN_INTERVAL_MS` in `src-tauri/src/commands/hue/sender.rs`. Going faster makes the bridge throttle and drop the stream.
- USB serial is gated by a **9-entry VID/PID allowlist** (`SUPPORTED_USB_DEVICE_ALLOWLIST` in `src-tauri/src/commands/device_connection.rs`): CH340, FTDI FT232R, CP2102, Arduino Uno R3+, Arduino Uno (early), PL2303, CH341, CP2104, FT232H. All ports are enumerated with `isSupported`; connect is blocked with `PORT_UNSUPPORTED` for the rest. Never hardcode the list elsewhere — read the constant.
- Serial link: 115 200 baud, 8N1.
- Window size: per-mode (see `UI_MODE_SIZES` / `UI_MODE_MIN_SIZES` in `src/shared/contracts/shell.ts`): full 900×620 (min 800×560), compact 320×480 (min 300×420).
- `MACOSX_DEPLOYMENT_TARGET` is pinned to `12.3` at workflow level in both CI and release. Lowering it reintroduces the 1.5.2 dyld launch crash (issue #115).
