# LumaSync

> Main context source for this repository — read this first. `AGENTS.md` only points here, so project rules belong in this file.

**LumaSync** is a native desktop application (Tauri 2 + React 19) that mirrors the screen to WS2812B LED strips, WLED devices, and Philips Hue entertainment areas in real time, with per-edge room-map calibration and fully local processing — no cloud. Package name: `lumasync`, identifier: `com.lumasync.app`.

## Where the reasoning lives

- **`docs/architecture/` — public, committed.** Technical decisions, gotchas and the reasoning behind them, one note per area; `docs/architecture/README.md` is the index. **Before changing an area, read its note** — the thing you find odd may be deliberate. A long explanation goes there, with a short comment in the code.
- **`devdocs/` — private, excluded from git.** Product direction, decisions, roadmap, research. It stays uncommitted and ignored, and collaborators, CI and sandboxed agents cannot see it. Committed source (comments included), commit messages, PRs and release notes name no `devdocs/` path; the reasoning goes into `docs/architecture/` instead. This file is the one exception, because it has to point there.

Read `devdocs/product/00-state.md`, the current-state file, before proposing a plan; where `devdocs/` is not available, read `CHANGELOG.md` and the open issues/PRs. When code and a document disagree, the code wins — say so and fix the document in the same change.

## Deliberately not built

Decisions, not gaps. Reopening one is fine; doing it without knowing it was decided is not.

- **Daemon or headless mode** — answered instead by autostart plus a planned loopback HTTP/WS API
- **Any outbound telemetry, analytics SDK, or third-party crash reporting** — including the "privacy-first" ones. Any feedback path must be user-initiated, user-inspectable, and abortable.
- **Cloud scene gallery, AI scene generation, proprietary peripheral bridges** (Razer, Corsair), **subscription gating**, **full-screen welcome wizard**, **container and Pi-headless distribution**
- **The room map on the first-run path** — it is an advanced surface. First run must reach working ambient lighting without it.

## Commands

`bun run tauri dev` is the primary development command; `bun run dev` runs the Vite server alone with no Tauri runtime. Everything else is in `package.json`. The build and test setup has traps — including `cargo build` and `bun run tauri build --debug` writing the same path with different binaries — read `docs/architecture/build-and-release.md` before losing an afternoon to one.

## Architecture

```
Frontend (React/TS)  →  Tauri Commands (Rust)  →  Device Layer (Serial / WLED UDP / Hue CLIP v2)
```

- **Contracts first.** Everything crossing the IPC boundary is defined in `src/shared/contracts/` before implementation; list that directory rather than trusting a summary. `bun run verify:shell-contracts` checks Rust against it — green means every status code is *declared*, not that it is *correct*.
- **Feature modules** (`ls src/features/`) use some of `ui/`, `state/`, `model/`, and an `*Api.ts` bridge over `invokeCommand`. A component and its `*.module.css` sit together in the feature that uses them, and move to `src/shared/ui/` only when a second feature needs them or they know nothing of any feature (`ui-and-shell.md`, "Code lives with the feature"). `hue` draws its bridge page but places nothing — placement is authored only in the room map (`hue.md`). `onboarding` does not include the room map.
- **Rust commands** live in `src-tauri/src/commands/`; the `generate_handler![]` block in `src-tauri/src/lib.rs` is the registration list.
- **State** persists in `shell-state.json` in the app data directory, and Rust owns it (`commands/shell_state.rs`, atomic writes plus `.bak`). The frontend goes through the `shellStore.ts` facade; shape changes go through `migrations.ts`. Hue credentials live in the OS keychain, never in that file. See `contracts-and-state.md`.
- **Auto-update** uses GitHub Releases with minisign verification (`build-and-release.md`).

## Code style

The surrounding code is the style guide. Only what a reader would not infer from it:

- **Rust command payloads** are typed `struct`s with `#[derive(Serialize)]` and `#[serde(rename_all = "camelCase")]`.
- **Coded errors, never swallowing a failure, contracts as source of truth, EN + TR moving together** are decisions, not style — `contracts-and-state.md`.
- **Tests** live in a `__tests__/` subfolder beside the code (`foo.ts` → `__tests__/foo.test.ts`). Double the Tauri boundary with `mockCommands` / `invokeFromCommands` from `src/test/mockCommands.ts`, typed by the command map; `verify:untyped-mocks` ratchets bare `vi.fn()` doubles down.

## Verification

Run after any change, lightest first:

1. `bun run typecheck`
2. `bun run test <changed-test-or-folder>`
3. `bun run verify:shell-contracts` — if contracts or commands were touched
4. `bun run check:i18n` — if a file that reads translation keys was added, moved, or **deleted** (deleting one orphans every key it alone referenced, and the orphan ratchet fails CI)
5. If Rust was touched, in `src-tauri/`: `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test --all-features -- --test-threads=1` — the flag is required (`build-and-release.md`)
6. `bun run build` — integration confidence

`bun run check:all` is the gate before a PR (typecheck, biome, `cargo check`, `check:i18n`, `verify:*`); it runs no vitest, cargo fmt/clippy/test or build, so steps 2, 5 and 6 still matter. On the maintainer's machine a Stop hook runs the fast checks for the working tree's changes and the pre-push hook runs `check:all`, vitest, fmt and clippy; when the Stop hook blocks, fix the failure or say plainly that the work is unfinished.

## Refactor discipline

- **A change to the app's chrome meets the screen-pass bar** — pages, panels, menus, settings and the dock, redesign or bug fix alike; in Claude Code the `screen-pass` skill holds the checklist. The 3D room canvas follows "Working in Claude Code" instead.
- **A screen reworked for its UI brings its code to the layout rule** (`ui-and-shell.md`, "Code lives with the feature") in the same change; a fix-only change offers the move.
- **A plan document is stale until proven otherwise** — re-derive its line numbers and file lists against current `main` before editing.
- **"Behaviour unchanged" is a claim to prove.** Diff the exported surface against `main`; where a guard is the point of the change, break the guard and confirm the test fails.
- **Invariant comments travel verbatim with the code they guard** — overriding a comment-guard hook is correct in exactly that case.
- **An empty import graph does not prove a file is dead.** Ask what it references that nothing else does — a zero-importer module can be the sole consumer of locale keys.
- **One writer per checkout.** Check `git status` before switching branches and stage paths by name; `git add -A`, `git commit -a`, `git checkout -- .`, `git restore .`, `git reset --hard`, `git clean` and `git stash` sweep up work you did not put there.
- **A PR is cut from fresh `main`, never stacked on an unmerged branch** — `main` squash-merges, so a stacked branch goes `DIRTY` when its base lands.
- **A locally measured flake rate is not evidence.** `vitest` sets no worker cap; reproduce the mechanism, and use `--maxWorkers=<n|%>` to leave the machine usable.

## Seeing and debugging the running app

- **Look at a screen instead of reasoning about JSX.** `e2e/specs/ui-audit.probe.ts` writes a PNG and a structural report per section. Read `testing-and-verification.md` before trusting a result: several of its blind spots return a clean empty result instead of failing, and a run shares the real `shell-state.json`.
- **Runtime symptoms are read from the log, not guessed.** Frontend and Rust share one file, `~/Library/Logs/com.lumasync.app/lumasync-dev.log` in dev; the clean restart and log patterns are in `docs/debugging.md`. A stack trace or failing test that already proves the bug is enough.

## Release rules

- **Work lands on `main` through pull requests, one per feature.** A PR carries one change that stands and reverts on its own — a feature, a screen pass, a fix with its test — never one per task-list item. Inside it, commit at every logical step and push freely; open the PR once the feature works, then auto-merge on green CI, sync and prune, each without a separate go-ahead. The next feature starts on a fresh branch from `main` in this checkout. A small fix found on the way rides along when it touches the same code; otherwise it goes to `devdocs/backlog.md`.
- **A PR leaves `CHANGELOG.md` alone.** Its body carries one `User-visible:` sentence instead — what a user notices, in about 25 words, or `none`. The release writes the version's notes from those lines.
- **Commit subjects stay short** — one conventional-commit line; detail, when needed, goes briefly in the body.
- **A release starts only on the maintainer's word** (in Claude Code, `/release`); the reasoning and the version and CI rules are in `build-and-release.md`.

## Key constraints

The ones that bite most often; each is explained in its area note.

- **Hue streaming floor is 50 ms** — a protocol limit, not a tuning knob (`hue.md`).
- **USB serial is gated by a VID/PID allowlist** — `SUPPORTED_USB_DEVICE_ALLOWLIST` in `device_connection.rs`; never hardcode the list elsewhere (`device-output.md`).
- **`MACOSX_DEPLOYMENT_TARGET` is pinned to 12.3** — lowering it reintroduces the v1.5.2 launch crash (`build-and-release.md`).
- **The capture-to-output path has a per-frame budget** — a regression is a defect, not a tuning matter (`capture-and-pipeline.md`).

## Working in Claude Code

**The main session is the only writer**; subagents under `.claude/agents/` are read-only consultants that return findings with file:line evidence. Parallel writers in one checkout conflict, while a clean-context reviewer catches what the author cannot.

A subagent sent to find where something lives runs on Sonnet; reviews, audits and claim checks run on Opus. Consult when a domain's risk is real — one targeted question beats a broad fan-out — and treat the answer as a draft: if it reads thin or contradicts the code, say so and check it. `contract-architect` is required for any Tauri command, status code, contract type, `ShellState` field or `migrations.ts` change, once on the proposed design and once on the diff.

The maintainer settles a UI direction in conversation before code is written; their taste is in `design-language.md` ("The interface is direct and quiet", "Motion is small"). The 3D room view is the exception — expressive light and motion, on the maintainer's word (`design-language.md`, under "Decisions"). Its visual work uses the `frontend-design` skill and is reviewed by `room-critic`.

`.claude/` is not committed, so a fresh clone has none of these. Without them, do the work directly and treat `docs/architecture/` as the authority the consultants would have cited.
