# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LumaSync** is a native desktop application (Tauri 2 + React 19) that mirrors the screen to WS2812B LED strips and Philips Hue entertainment areas in real time, with per-edge room-map calibration and fully local processing. Package name: `lumasync`, identifier: `com.lumasync.app`.

## Where the reasoning lives

Two sets, and the split is what is shareable. Each one keeps its own index; this file points at
them and holds neither map, so it does not go stale when a note is added.

- **`docs/architecture/README.md` — public, committed.** Technical decisions, gotchas, and the reasoning behind them. This is where a long explanation belongs instead of a twenty-line comment above a function: **write the reason there and keep the comment short.** Committed source may link to it freely.
- **`devdocs/README.md` — private, excluded from git.** Product direction, goals, roadmap, research. **Never committed, unignored, or distributed**; assume collaborators, CI, and sandboxed agents cannot see it. **Never reference a `devdocs/` path from committed source, commit messages, PRs, or release notes** — it is a dead reference for every other reader. Put the reasoning in `docs/architecture/` instead, or inline it.

`docs/architecture/` is split by area — Hue, device output, capture, contracts, build, UI — so
reading about one does not mean loading all of them. Its README routes by task.

Before changing anything: the area file for whether the thing you find odd is deliberate, and
`devdocs/product/00-state.md` for where the project stands.

## Deliberately not built

Decisions, not gaps. Reopening one is fine; doing it without knowing it was decided is not.
Reasons and accepted costs are in `devdocs/product/02-decisions.md`.

- **Daemon or headless mode** — answered instead by autostart plus a planned loopback HTTP/WS API
- **Any outbound telemetry, analytics SDK, or third-party crash reporting** — including the "privacy-first" ones. Any feedback path must be user-initiated, user-inspectable, and abortable.
- **Cloud scene gallery, AI scene generation, proprietary peripheral bridges** (Razer, Corsair), **subscription gating**, **full-screen welcome wizard**, **container and Pi-headless distribution**
- **The room map on the first-run path** — it is an advanced surface. First run must reach working ambient lighting without it.

## Agent Routing

This project uses specialist agents in `.claude/agents/`. They are the primary authority for their domains. The main assistant is an **orchestrator**, not an inline worker.

**`.claude/` is not committed.** The agents and skills named below exist on the maintainer's machine only, so a fresh clone has none of them and this section describes nothing it can reach. If you are working without them, the routing below is still a useful map of which domains need care — just do the work directly, and treat the constraints in `docs/architecture/` as the authority the agents would have cited.

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
- Conversational back-and-forth during the **design discussion phase**, before any code is written. The maintainer prefers to settle a UI direction in conversation first; jumping straight to an implementation means discarding it.

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

Three traps live in the build and test setup, including one where `cargo build` and
`pnpm tauri build --debug` write the same path and produce different binaries — read
`docs/architecture/build-and-release.md` before losing an afternoon to any of them.

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

- **`hue` holds no UI.** The module is state, model, and the `invoke()` bridge; the Hue screens live in `settings/sections/DeviceSection.tsx` and `HueChannelMapPanel.tsx`, and the contract in `src/shared/contracts/hue.ts`.
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
`#[serde(rename_all = "camelCase")]`.

**Comments.** Comment a non-obvious *why* — a gotcha, a workaround, an invariant, a subtle edge
case — and nothing else. When the explanation runs long, it belongs in `docs/architecture/`, with
the comment reduced to a line and a pointer. Never restate what the code plainly does.

Coded errors, never swallowing a failure, contracts as the source of truth, and EN + TR moving
together are decisions rather than style — see `docs/architecture/contracts-and-state.md`.

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

The ones that bite most often. Each is explained where it applies, under `docs/architecture/`:

- **Hue streaming floor is 50 ms** — a protocol limit, not a tuning knob. Faster and the bridge throttles and drops the stream. (`hue.md`)
- **USB serial is gated by a 9-entry VID/PID allowlist** — `SUPPORTED_USB_DEVICE_ALLOWLIST` in `src-tauri/src/commands/device_connection.rs`. Read the constant; never hardcode the list elsewhere. (`device-output.md`)
- **`MACOSX_DEPLOYMENT_TARGET` is pinned to 12.3** — lowering it reintroduces the v1.5.2 launch crash. (`build-and-release.md`)
- **The capture-to-output path has a per-frame budget** — a regression in it is a defect, not a tuning matter. (`capture-and-pipeline.md`)
