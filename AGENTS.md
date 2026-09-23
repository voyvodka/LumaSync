# AGENTS.md — LumaSync

Instructions for coding agents working in this repository. `CLAUDE.md` imports this file and adds
only Claude Code–specific routing (specialist agents and skills under `.claude/`, which is not
committed), so project rules belong here.

## Project Overview

**LumaSync** is a native desktop application (Tauri 2 + React 19) that mirrors the screen to WS2812B LED strips, WLED devices, and Philips Hue entertainment areas in real time, with per-edge room-map calibration and fully local processing — no cloud. Package name: `lumasync`, identifier: `com.lumasync.app`.

## Where the reasoning lives

Two sets, and the split is what is shareable. Each one keeps its own index; this file points at
them and holds neither map, so it does not go stale when a note is added.

- **`docs/architecture/README.md` — public, committed.** Technical decisions, gotchas, and the reasoning behind them. This is where a long explanation belongs instead of a twenty-line comment above a function: **write the reason there and keep the comment short.** Committed source may link to it freely.
- **`devdocs/README.md` — private, excluded from git.** Product direction, goals, roadmap, research. **Never committed, unignored, or distributed**; assume collaborators, CI, and sandboxed agents cannot see it. **Never reference a `devdocs/` path from committed source (including source-code comments), commit messages, PRs, or release notes, and never propose committing it** — it is a dead reference for every other reader. Put the reasoning in `docs/architecture/` instead, or inline it.

`docs/architecture/` is split by area — Hue, device output, serial protocol, capture, contracts,
build, testing, UI, room map — so reading about one does not mean loading all of them. Its README
routes by task.

Before changing anything: the area file for whether the thing you find odd is deliberate, and
`devdocs/product/00-state.md` for where the project stands. Where `devdocs/` is not available, read
`CHANGELOG.md` and the open issues/PRs (`gh issue list`, `gh pr list`) instead.

## Deliberately not built

Decisions, not gaps. Reopening one is fine; doing it without knowing it was decided is not.
Reasons and accepted costs are in `devdocs/product/02-decisions.md`.

- **Daemon or headless mode** — answered instead by autostart plus a planned loopback HTTP/WS API
- **Any outbound telemetry, analytics SDK, or third-party crash reporting** — including the "privacy-first" ones. Any feedback path must be user-initiated, user-inspectable, and abortable.
- **Cloud scene gallery, AI scene generation, proprietary peripheral bridges** (Razer, Corsair), **subscription gating**, **full-screen welcome wizard**, **container and Pi-headless distribution**
- **The room map on the first-run path** — it is an advanced surface. First run must reach working ambient lighting without it.

## Commands

`bun run tauri dev` is the primary development command; `bun run dev` runs the Vite server alone with no
Tauri runtime. Everything else is in `package.json` — read it there. The verification sequence is
below under **Verification Flow**; `cargo audit` ignores live in `src-tauri/.cargo/audit.toml`.

Three traps live in the build and test setup, including one where `cargo build` and
`bun run tauri build --debug` write the same path and produce different binaries — read
`docs/architecture/build-and-release.md` before losing an afternoon to any of them.

## Architecture

```
Frontend (React/TS)  →  Tauri Commands (Rust)  →  Device Layer (Serial/HTTP)
```

- **Frontend** (`src/`): React 19, TypeScript strict, Tailwind CSS 4, i18next
- **Tauri Runtime** (`src-tauri/src/`): Rust 2021 edition, tray, window state, auto-updates
- **Device Layer**: Serial port (USB microcontrollers at 115200 baud), WLED over UDP (DDP, or DRGB/DNRGB), and the Philips Hue CLIP v2 API

### Contract-First Design

All frontend–backend communication is defined in `src/shared/contracts/` **before**
implementation. That directory is the source of truth; list it rather than working from any
summary. `scripts/verify/phase01-shell-contracts.mjs` checks that Rust handlers match the
frontend definitions — run `bun run verify:shell-contracts` after touching either side.

A green verifier means every status code crossing the IPC boundary is *declared*, not that it is
*correct*. It is a drift guard, not a coverage score.

### Feature modules (`src/features/`)

Each module uses some of `ui/` (React components), `state/` (state machines and hooks),
`model/` (domain types), and `*Api.ts` (the `invoke()` bridge). Small ones are a flat file or two.
`ls src/features/` is the authoritative list.

Two things the directory listing will not tell you:

- **`hue` holds no UI.** The module is state, model, and the `invoke()` bridge; the contract is in `src/shared/contracts/hue.ts`. The Hue screens are split by what they own: `settings/sections/DeviceSection.tsx` and `HueChannelMapPanel.tsx` list the bridge's channels and own the bridge sync, while **placement is authored only in the room map** — see `docs/architecture/hue.md`.
- **`onboarding` does not include the room map.** That editor is an advanced surface most users skip; first run must work without it.

### Rust command modules (`src-tauri/src/commands/`)

Around twenty files plus the `hue/`, `lighting_mode/` and `room_map/` subdirectories. Grep for
`#[tauri::command]`; the `generate_handler![]` block in `src-tauri/src/lib.rs` is the
authoritative registration list.

### State persistence

`shell-state.json` lives in the app data directory — on macOS
`~/Library/Application Support/com.lumasync.app/shell-state.json`
(Windows `%APPDATA%\com.lumasync.app\`, Linux `~/.local/share/com.lumasync.app/`).
Rust owns it: `commands/shell_state.rs` is the only reader and writer, with atomic
writes and a `.bak`, and every window goes through the `get_shell_state` /
`patch_shell_state` commands. The `shellStore.ts` facade wraps all frontend
read/write operations, and `migrations.ts` handles shape changes. Stored keys
follow `ShellState` in `shell.ts`. See `docs/architecture/contracts-and-state.md`,
"Shell-state ownership".

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
unless explicitly asked" rule does NOT apply here. `bun run test`, `cargo test`, and
`bun run verify:shell-contracts` are part of the normal loop and may be run without asking. Tests
live in a `__tests__/` subfolder beside the code under test (`foo.ts` → `__tests__/foo.test.ts`),
never co-located. Mock the Tauri boundary for deterministic frontend tests. Only add or adjust
tests for changed behaviour.

## Verification Flow

Run after any change, lightest checks first:

1. `bun run typecheck`
2. `bun run test <changed-test-or-folder>`
3. `bun run verify:shell-contracts` (if contracts/commands touched)
4. `bun run check:i18n` (if a file that reads translation keys was added, moved, or **deleted** — deleting a file orphans every key it alone referenced, and the orphan ratchet fails CI on it)
5. `bun run check:rust` (if Rust touched)
6. `cargo fmt --all -- --check` + `cargo clippy --all-targets --all-features -- -D warnings` + `cargo test -- --test-threads=1` (if Rust touched — CI enforces all three, clippy at deny level)
7. `bun run build` (integration confidence)

Before opening a PR, run `bun run check:all` — it is what CI runs, and it is a superset of steps 1, 3,
4 and 5. Running the four individually is not the same thing; that gap is how a green local tree
still fails the build.

## Refactor discipline

Learned across the v1.5 frontend decomposition, where each of these cost a cycle before it was
written down. They apply to any structural change.

- **A plan document is stale until proven otherwise.** Every design in that series described a tree
  that had moved — line citations off by 50, files already deleted, bugs already fixed by an
  intervening PR. Audit the design against current `main` and re-derive every line number and file
  list before editing. Following a stale plan reopens closed work or cuts the wrong line.
- **"Behaviour unchanged" is a claim to prove, not assert.** Diff the exported surface against
  `main` and say it is byte-identical because you diffed it. Where a guard is the point of the
  change, break the guard and confirm the test fails — a test that passes against broken code was
  never protecting anything.
- **Invariant comments travel verbatim with the code they guard.** A comment explaining why an
  ordering, a sticky flag, or a narrow error-code list must not be "simplified" is the only thing
  stopping the next split from dropping the rule. The comment-guard hook will object when you move
  one; overriding it is correct in exactly that case and nowhere else.
- **An empty import graph does not prove a file is dead.** Ask what the file references that
  nothing else does. A module with zero importers was the sole consumer of twenty catalogue keys;
  deleting it orphaned all twenty and failed CI.
- **One writer per checkout.** Two things editing one working tree corrupts both and makes a
  behaviour-neutral claim unverifiable. Check `git status` before switching branches, and never run
  `git add -A`, `git commit -a`, `git checkout -- .`, `git restore .`, `git reset --hard`,
  `git clean` or `git stash` — they discard work you did not put there. Stage paths by name.
- **Do not stack a PR on an unmerged branch.** `main` squash-merges, so when the base lands its
  commits collapse and the stacked branch goes `DIRTY` with add/add conflicts. Wait for the base,
  or cherry-pick onto fresh `main` and open a new PR — rebasing would need a force-push.
- **A locally measured flake rate is not evidence.** `vitest` sets no worker cap, so a run takes
  whatever the machine has left; the same tree can give zero failures in one batch of twenty and
  two in the next. Reproduce the mechanism instead — force the lag, mutate the code — and quote
  that. Use `--maxWorkers=<n|%>` when a run needs to leave the machine usable.

## Seeing the UI instead of reasoning about it

A screen can be looked at, not just inferred from JSX.
`e2e/specs/ui-audit.probe.ts` drives the real window, writes a PNG per
section and a structural report — unnamed controls, selection state
carried only in CSS, clipped text, a tripped error boundary. Reading the
PNG beats arguing from the component tree, and it costs one build plus a
few seconds:

```bash
bun run e2e:build   # skip if the binary is current; cargo test invalidates it
LUMASYNC_AUDIT_SECTION=devices npx wdio run wdio.conf.ts --spec e2e/specs/ui-audit.probe.ts
```

**Read `docs/architecture/testing-and-verification.md` before trusting a
result.** Three things return a clean, empty, believable answer rather
than failing: CSS `:hover` never fires (the driver's pointer events are
synthetic), an IPC hook installed from a spec records zero while the
backend works, and only the `main` window is reachable. A run also shares
the real `shell-state.json` — warn before driving a machine in use.

## Debugging: Live Log Analysis

Claude Code wraps the clean-restart, capture, and classify sequence below in the `debug-runtime`
skill (see `CLAUDE.md`). The manual path:

```bash
# Kill any running instance, clear the leaked single-instance socket, start fresh
pkill -9 -f "tauri dev" 2>/dev/null; pkill -9 -f "target/debug/lumasync" 2>/dev/null; sleep 2
rm -f /tmp/com_lumasync_app_si.sock
bun run tauri dev > /tmp/lumasync-debug-stdout.log 2>&1 &
```

- **One log file holds everything.** `src/main.tsx` wraps `console.log/info/warn/error`
  and forwards them into `tauri-plugin-log`, so frontend output lands in the same
  sink as Rust's `log::info!`/`log::warn!`. On macOS that file is
  `~/Library/Logs/com.lumasync.app/lumasync-dev.log` (dev) /
  `lumasync.log` (release; an older `LumaSync.log` is the same file on a
  case-insensitive filesystem). Read the file first; terminal stdout only helps for
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

In Claude Code the full procedure — CI steps, the readiness checklist, CHANGELOG style, and how
publication works — is owned by the `release-manager` agent and the `ls-ci-release-standards` skill
(see `CLAUDE.md`). Both live only on the maintainer's machine; without them, follow the rules
below and `docs/architecture/build-and-release.md`.

**Patch bumps only.** Every release is a patch bump for the foreseeable future, whatever the change
contains. Do not classify the bump from the diff — the answer is always patch until the maintainer
says otherwise. A change that is genuinely breaking still ships under a patch number, so it must be
called out in the release notes in as many words.

**Green CI proves less than it looks like.** `scripts/verify/launch-smoke.mjs` launches the debug
binary on all three platforms. Windows uses a smoke-only visible-window config because WebView2 can
drop an embedded debug webview's first request when it starts hidden
([#181](https://github.com/voyvodka/LumaSync/issues/181)); production keeps its hidden startup.
`release.yml` launches the mounted `.dmg`, AppImage, and Windows release binary before publishing.
The `.msi` and `.deb` installers are still never installed in CI, so do not describe either
installer as verified on the strength of a green run.

Four things must stay true regardless of who does the work:

- **Four version locations move in lockstep**: `src-tauri/Cargo.toml`, `package.json`, `SECURITY.md`, and `bundle.windows.wix.version` in `tauri.conf.json`. Then `cargo check` to refresh `Cargo.lock`. The first three carry the full version including any prerelease suffix; the wix one carries the bare `X.Y.Z`, because MSI rejects a non-numeric prerelease identifier. The tag gate in `release.yml` checks all four, and `bun run verify:version-parity` (inside `check:all`) checks the same rules on every PR so a drift fails before it is merged rather than at tag time.
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
