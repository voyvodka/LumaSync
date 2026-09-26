# LumaSync

> Main context source for this repository — read this first. `AGENTS.md` only points here, so
> project rules belong in this file.

**LumaSync** is a native desktop application (Tauri 2 + React 19) that mirrors the screen to WS2812B
LED strips, WLED devices, and Philips Hue entertainment areas in real time, with per-edge room-map
calibration and fully local processing — no cloud. Package name: `lumasync`, identifier:
`com.lumasync.app`.

## Where the reasoning lives

Two sets, and the split is what is shareable. Each keeps its own index; this file holds neither map.

- **`docs/architecture/README.md` — public, committed.** Technical decisions, gotchas, and the reasoning behind them, split by area so reading about one does not load all of them: `hue`, `device-output`, `serial-protocol`, `capture-and-pipeline`, `lighting-transaction`, `contracts-and-state`, `room-map`, `ui-and-shell`, `design-language`, `build-and-release`, `testing-and-verification`, `references`. **Before changing an area, read its note** — the thing you find odd may be deliberate. A long explanation goes there, not into a twenty-line comment: write the reason there and keep the comment short.
- **`devdocs/README.md` — private, excluded from git.** Product direction, decisions, roadmap, research. **Never committed, unignored, or distributed**; assume collaborators, CI, and sandboxed agents cannot see it. **Never reference a `devdocs/` path from committed source (including comments), commit messages, PRs, or release notes.** Put the reasoning in `docs/architecture/` instead.

Read `devdocs/product/00-state.md` for where the project stands before proposing a plan. Where
`devdocs/` is not available, read `CHANGELOG.md` and the open issues/PRs instead. When code and a
document disagree, the code wins — say so and fix the document in the same change.

## Deliberately not built

Decisions, not gaps. Reopening one is fine; doing it without knowing it was decided is not.

- **Daemon or headless mode** — answered instead by autostart plus a planned loopback HTTP/WS API
- **Any outbound telemetry, analytics SDK, or third-party crash reporting** — including the "privacy-first" ones. Any feedback path must be user-initiated, user-inspectable, and abortable.
- **Cloud scene gallery, AI scene generation, proprietary peripheral bridges** (Razer, Corsair), **subscription gating**, **full-screen welcome wizard**, **container and Pi-headless distribution**
- **The room map on the first-run path** — it is an advanced surface. First run must reach working ambient lighting without it.

## Commands

`bun run tauri dev` is the primary development command; `bun run dev` runs the Vite server alone with
no Tauri runtime. Everything else is in `package.json`. Three traps live in the build and test setup —
including `cargo build` and `bun run tauri build --debug` writing the same path with different
binaries — read `docs/architecture/build-and-release.md` before losing an afternoon to one.

## Architecture

```
Frontend (React/TS)  →  Tauri Commands (Rust)  →  Device Layer (Serial / WLED UDP / Hue CLIP v2)
```

- **Contracts first.** Everything crossing the IPC boundary is defined in `src/shared/contracts/` **before** implementation; that directory is the source of truth — list it rather than trusting a summary. `bun run verify:shell-contracts` checks Rust against it. A green verifier means every status code is *declared*, not that it is *correct*.
- **Feature modules** (`src/features/`) use some of `ui/`, `state/`, `model/`, and an `*Api.ts` `invoke()` bridge; `ls src/features/` is the authoritative list. A component and its `*.module.css` sit together in the feature that uses them, and move to `src/shared/ui/` only when a second feature needs them or they know nothing of any feature (`ui-and-shell.md`, "Code lives with the feature"). `hue` holds no UI — placement is authored only in the room map (`docs/architecture/hue.md`). `onboarding` does not include the room map.
- **Rust commands** live in `src-tauri/src/commands/`; the `generate_handler![]` block in `src-tauri/src/lib.rs` is the authoritative registration list.
- **State** persists in `shell-state.json` in the app data directory, and Rust owns it (`commands/shell_state.rs`, atomic writes plus `.bak`). The frontend goes through the `shellStore.ts` facade; shape changes go through `migrations.ts`. Hue credentials live in the OS keychain, never in that file. See `contracts-and-state.md`.
- **Auto-update** uses GitHub Releases with minisign verification (`build-and-release.md`).

## Code style

The surrounding code is the style guide. Only what a reader would not infer from it:

- **Rust command payloads** are typed `struct`s with `#[derive(Serialize)]` and `#[serde(rename_all = "camelCase")]`.
- **Comments** state a non-obvious *why* — a gotcha, workaround, invariant, subtle edge case — and nothing else. Never restate what the code does.
- **Coded errors, never swallowing a failure, contracts as source of truth, EN + TR moving together** are decisions, not style — `contracts-and-state.md`.
- **Tests may be run without asking** — the global "do not run tests unless asked" rule does NOT apply here. Tests live in a `__tests__/` subfolder beside the code (`foo.ts` → `__tests__/foo.test.ts`), never co-located. Mock the Tauri boundary at `@tauri-apps/api/core`. Only add or adjust tests for changed behaviour.

## Verification

Run after any change, lightest first:

1. `bun run typecheck`
2. `bun run test <changed-test-or-folder>`
3. `bun run verify:shell-contracts` — if contracts or commands were touched
4. `bun run check:i18n` — if a file that reads translation keys was added, moved, or **deleted** (deleting one orphans every key it alone referenced, and the orphan ratchet fails CI)
5. `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test -- --test-threads=1` — if Rust was touched; CI enforces all three
6. `bun run build` — integration confidence

Before opening a PR, run `bun run check:all` — it is what CI runs, and it is a superset of the
individual checks; running them one by one is how a green local tree still fails the build.

Two local gates enforce this on the maintainer's machine: a Claude Code **Stop hook** runs the fast
checks for whatever the working tree changed before a turn may end, and a git **pre-push** hook runs
`check:all`, the tests, fmt and clippy (skipped for docs-only pushes). If the Stop hook blocks, fix
the failure or say plainly that the work is unfinished — never report it done.

## Refactor discipline

Learned across the v1.5 frontend decomposition, where each of these cost a cycle before it was written down.

- **A screen reworked for its UI brings its code with it.** The maintainer improves the app screen by screen; each pass also moves that screen's code to the layout rule (`ui-and-shell.md`, "Code lives with the feature") in the same change, so the frontend converges without a big-bang move.
- **A plan document is stale until proven otherwise.** Audit it against current `main` and re-derive every line number and file list before editing.
- **"Behaviour unchanged" is a claim to prove, not assert.** Diff the exported surface against `main`. Where a guard is the point of the change, break the guard and confirm the test fails.
- **Invariant comments travel verbatim with the code they guard.** The comment-guard hook will object when you move one; overriding it is correct in exactly that case.
- **An empty import graph does not prove a file is dead.** Ask what it references that nothing else does — a zero-importer module was the sole consumer of twenty catalogue keys.
- **One writer per checkout.** Check `git status` before switching branches. Never run `git add -A`, `git commit -a`, `git checkout -- .`, `git restore .`, `git reset --hard`, `git clean` or `git stash` — they discard work you did not put there. Stage paths by name.
- **Do not stack a PR on an unmerged branch.** `main` squash-merges, so a stacked branch goes `DIRTY` when its base lands. Wait, or cherry-pick onto fresh `main`.
- **A locally measured flake rate is not evidence.** `vitest` sets no worker cap; reproduce the mechanism instead, and use `--maxWorkers=<n|%>` to leave the machine usable.

## Seeing and debugging the running app

- **Look at a screen instead of reasoning about JSX.** `e2e/specs/ui-audit.probe.ts` writes a PNG and a structural report per section; the `ui-audit` skill drives it. Read `testing-and-verification.md` before trusting a result — `:hover` never fires, IPC hooks from a spec record zero, only `main` is reachable, and a run shares the real `shell-state.json`.
- **Runtime symptoms are read from the log, not guessed.** Frontend and Rust share one file: `~/Library/Logs/com.lumasync.app/lumasync-dev.log` in dev. The clean restart, level config and log patterns are in `docs/debugging.md`; the `debug-runtime` skill wraps them. Skip it only when a stack trace or failing test already proves the bug.

## Release rules

The procedure is the `release` skill (triggered by "X.Y.Z atıyorum", "release hazırla", "yeni
versiyon"); the reasoning is `build-and-release.md`. Rules that hold regardless of who does it:

- **Patch bumps only**, whatever the change contains, until the maintainer says otherwise. A genuinely breaking change still ships under a patch number and is called out in the release notes.
- **Four version locations move in lockstep** — `src-tauri/Cargo.toml`, `package.json`, `SECURITY.md` (full version) and `bundle.windows.wix.version` in `tauri.conf.json` (bare `X.Y.Z`; MSI rejects prerelease identifiers) — then `cargo check` to refresh `Cargo.lock`. `verify:version-parity` checks it on every PR.
- **No duplicate `## [X.Y.Z]` headings in `CHANGELOG.md`** — `release.yml` extracts notes with `awk` and stops at the first match.
- **Work lands on `main` through pull requests.** Renaming a CI job renames its required status context and blocks every PR.
- **Green CI proves less than it looks.** The `.msi` and `.deb` are never installed in CI; do not describe either as verified.
- **Do NOT commit, tag, or push unless the user explicitly asks.**

## Key constraints

The ones that bite most often; each is explained in its area note.

- **Hue streaming floor is 50 ms** — a protocol limit, not a tuning knob (`hue.md`).
- **USB serial is gated by a 9-entry VID/PID allowlist** — `SUPPORTED_USB_DEVICE_ALLOWLIST` in `device_connection.rs`; never hardcode the list elsewhere (`device-output.md`).
- **`MACOSX_DEPLOYMENT_TARGET` is pinned to 12.3** — lowering it reintroduces the v1.5.2 launch crash (`build-and-release.md`).
- **The capture-to-output path has a per-frame budget** — a regression is a defect, not a tuning matter (`capture-and-pipeline.md`).

## Working in Claude Code

**The main session is the only writer.** It plans, edits, and verifies. Subagents under
`.claude/agents/` are **read-only consultants**: they investigate or review and return findings
with file:line evidence; they never edit. Parallel writers in one checkout conflict and cost far
more than they return, while a clean-context reviewer catches what the author cannot.

| Consult | When |
|---|---|
| `contract-architect` | **Required** for any Tauri command, status code, contract type, `ShellState` field or `migrations.ts` change — once on the proposed design, once on the diff |
| `hardware-expert` | Before designing or changing Hue, serial/LED, WLED, `LedSink`, capture or per-frame code; when a device symptom needs a protocol-level read |
| `ui-ux-expert` | While settling a UI direction, and to review a UI, styles or locales diff |
| `reviewer` | On a finished change set before the PR — correctness, test adequacy, open-source hygiene |

Consult when a domain's risk is real, not by reflex; one targeted question beats a broad fan-out.
A consultant's answer is a draft — if it reads thin or contradicts the code, say so and check it.
The maintainer prefers to settle a UI direction in conversation before any code is written.
Their UI taste — direct, quiet, not corporate; few words; nothing shifting under the pointer; tiny
motion that answers a change — is written down in `design-language.md` ("The interface is direct and
quiet" and "Motion is small"). Read it before any UI work instead of asking again.
Agent and skill definitions, toolchains and available models drift silently — when you notice one
out of date, say so in a sentence rather than opening a project.

Skills: `debug-runtime` and `ui-audit` (above), `release`, and `sweep` — a find-and-fix pass where
read-only auditors report, the maintainer picks, and the main session fixes one finding at a time
through the verification gate.

`.claude/` is not committed, so a fresh clone has none of these. Without them, do the work
directly and treat `docs/architecture/` as the authority the consultants would have cited.
