# Contracts, IPC, and persisted state

How the TypeScript and Rust halves agree on anything, and what survives a restart.

## Decisions

**Contract-first, always.** Every shape crossing the boundary is defined in
`src/shared/contracts/` **before** implementation. That directory is the source of truth — work
from it rather than from any summary, including this one. Run `bun run verify:shell-contracts` after
touching either side; it checks that Rust handlers match the frontend definitions.

**One typed command table.** `CommandMap` in `src/shared/contracts/ipc.ts` gives every command the
contracts declare its `args` (the object `invoke()` sends, keyed by the Rust parameter names) and
its `result`. Two type-level guards hold it equal to the `*_COMMANDS` maps in both directions.
Bridges call `invokeCommand` (`src/shared/ipcApi.ts`), never `invoke`, so a misspelt command, a
payload key the handler never reads, or a result typed against the wrong shape is a compile error.
A bridge that wants an injectable transport takes a `CommandInvoker` — one type for every bridge —
and tests hand it `mockCommands({...})` from `src/test/mockCommands.ts`, typed by the same map; the
dev mock's `TypedHandlers` is too. The table is type-only on purpose: `verify:window-grants` reads
every `*_COMMANDS.X` a window's live code names, so a runtime import of the whole table would make
every window look like it invokes every command. Every `Serialize` struct that reaches the
frontend has a same-named (or aliased) contract interface; the verifier's unpaired-struct ratchet
is empty and a new unpaired struct fails. A struct that only ever *enters* Rust derives
`Deserialize` alone.

**Coded status, never a bare string.** A command returns a stable machine-readable status code
alongside the human-readable message. Never a bare string error, and never a code invented at the
call site — a code that exists in one place cannot be handled, translated, or searched for.

**One status envelope, parameterised by a wire union.** `CommandStatusOf<TCode>` in
`src/shared/contracts/status.ts` is the only coded-status shape; each domain aliases it with its
own union. Its one Rust mirror is `CommandStatus` in `src-tauri/src/commands/status.rs`, and the
verifier fails on any second struct carrying exactly `code`, `message` and `details`: four
per-module copies once drifted apart on their derives while the TS side typed one of them as
`details?: string` against a wire that always sends `null`. `TCode` is always the *wire* union — exactly the set the Rust producer puts on that
shape, no more. Codes the frontend mints (a transport rejection, a synthesised "no command ran")
live in a separate union that widens the wire one at the consumer holding both, so a
frontend-invented code can never pose as something the backend can send. `SerialHealthStepWireCode`
/ `SerialHealthStepCode` and `HueOnboardingWireStatusCode` / `HueOnboardingStatus` (the latter in
`features/hue/model/onboardingStatusCodes.ts`) are the two worked examples. `SomeCode | string` is banned outright: it reads as typed and admits everything,
which is harder to spot than a bare `string`.

**Failures are never swallowed.** An empty `catch {}` is a defect here, not a shortcut. Log with
the `[LumaSync]` prefix.

**A rejection is read once, by `parseCommandError` in `shared/contracts/status.ts`.** Every
`Result<_, String>` command rejects with a bare string, by convention `"CODE: context"`. The
frontend used to read it a dozen ways: `modeApi` expected an object with `.code`, so every string
became `UNKNOWN` with a placeholder message and nothing in the log; `x instanceof Error ? x.message
: String(x)` turned that thrown `ModeApiError` object into `"[object Object]"`. The parser takes a
string, an `Error` or a structured `{ code, message, details }`, and never serialises an object
without a `message` — a transport failure must not echo a payload that holds credentials. Its
`message` and `details` are raw backend text and can carry a bridge's response body, so they are
rendered only as text nodes, never as a `<Trans>` value: i18n runs with `escapeValue: false`, and
`<Trans>` parses its interpolated string for tags. `transValues.test.ts` allowlists the keys a
`<Trans values>` may use. In Rust, return coded context through a status object or
`Result<_, String>`. For invalid external input, prefer an explicit fallback value over a silent
default — a silent default hides the fact that the input was wrong.

**State persists in `shell-state.json`, and Rust owns the file.** It sits in the app data
directory: `~/Library/Application Support/com.lumasync.app/` on macOS, `%APPDATA%\com.lumasync.app\`
on Windows, `~/.local/share/com.lumasync.app/` on Linux. `ShellStateStore` in
`src-tauri/src/commands/shell_state.rs` is the only thing that reads or writes it; see
[Shell-state ownership](#shell-state-ownership) below.

**All frontend reads and writes go through the `shellStore.ts` facade**, and shape changes go
through `migrations.ts`. Stored keys follow `ShellState` in `shell.ts`.

**Import layers are lint-enforced.** `biome.json` (`noRestrictedImports`, run by `bun run lint`)
holds three rules. `@tauri-apps/*` is imported only by a feature's `*Api.ts` bridge and
`shared/ipcApi.ts` (the typed `invoke`), plus `main.tsx` (the log bridge and window-label routing, before any feature loads),
the main window's driver — `shell/windowLifecycle.ts`, `windowGeometry.ts` and `windowAnimator.ts`
(boot, geometry and the mode resize; the store behind them, `windowShellState.ts`, goes through
`persistence/shellStateApi.ts`) — and `tray/trayController.ts` (tray events
and autostart) — a component or hook that wants the window, an event or a plugin goes through a
bridge, so a test can mock one module and a capability audit has one caller to read. Events use a
`*EventsApi.ts` beside the command bridge. `plugin-store` is opened only by `windowLifecycle.ts`,
behind `shellStore`; `plugin-fs` and `plugin-dialog` only by `room-map/roomMapFilesApi.ts`. And
`src/shared/**` never imports `src/features/**`: a type both need moves into `shared/contracts/`,
which is why the lighting-mode contract is `shared/contracts/mode.ts`. Tests are exempt.

**i18n keys are stable and scoped by feature.** EN and TR move together — a locale-parity test
enforces it, so a key added to one and not the other fails the suite. `check:i18n`
(`scripts/verify/i18n-keys.mjs`) ratchets orphans, and a `` t(`prefix.${x}`) `` site references
only the children its contract value set can produce — so a key whose value left the contract turns
orphan instead of hiding under the prefix, and a contract value with no message fails.

## Shell-state ownership

Until this design every webview opened `shell-state.json` through `@tauri-apps/plugin-store` and
saved with a read-modify-write of the whole blob, serialised only by a JS queue inside that one
webview. The main window and the LED control popup could each read the same snapshot and write it
back, and the later write reverted the earlier one's fields. Rust read the file raw in five
places, and the plugin wrote it with a plain `fs::write` — a crash mid-write left a truncated
file, which the plugin then silently replaced with the defaults on the next save.

**One owner.** `ShellStateStore` (`src-tauri/src/commands/shell_state.rs`, managed state) loads
the file once, lazily, and holds the parsed object in memory behind one mutex. That copy is the
authority: every write goes through it, and every Rust reader (`lighting_mode`'s calibration,
ambilight and output-stamp fallbacks, the display aspect, `updater`'s channel, the popup's saved
centre) takes a typed accessor on a `PersistedShellState` snapshot instead of opening the file.
The key names Rust reads are spelled once, in that module.

**Three commands, declared in `SHELL_COMMANDS`.**

- `get_shell_state` → `{ state, revision }`. `state` is `null` when nothing was ever stored.
  `revision` counts accepted writes since the process started; it only means something to a
  later `replace_shell_state`.
- `patch_shell_state({ set, remove, writerId })` merges top-level keys under the mutex, writes,
  and emits `shell://state-changed`. `remove` exists because the old write path dropped a key
  whose partial value was `undefined` (`{ ...current, ...partial }` serialised through JSON), and
  callers rely on that: clearing `hueAppKey`/`hueClientKey` once the keychain holds them,
  swapping `lastSuccessfulPort` for `lastWledSink`. `invoke` would drop an `undefined` silently,
  so the bridge moves those keys into `remove`. Losing that would leave a plaintext Hue key on
  disk.
- `replace_shell_state({ state, expectedRevision, writerId })` swaps the whole object only if no
  write landed since the caller's `get_shell_state`; otherwise it answers `applied: false` and
  writes nothing.

**Migration write-back uses `replace_shell_state`, not a patch.** `loadShellState` still migrates in
TypeScript. When the stored `schemaVersion` is behind, it replaces the object, guarded by the
revision it read. On a conflict it reads again and re-migrates the fresh state, up to three
attempts. Two cheaper guards were rejected. A compare-and-swap on `schemaVersion` misses exactly
the race that matters: a concurrent patch leaves the version alone, so it would be overwritten.
Patching only the migrated keys cannot delete the legacy keys a step removes, and a step rewrites
`roomMap`, which another window may have just patched. A failed write-back is logged and is not
fatal: the migrated object is still returned, and the next load retries. The twin overlay has no
grant for `replace_shell_state`, and it must still boot.

**`shellStore.update` is the read-modify-write for a nested key.** A patch replaces a top-level
key whole, so load-then-save of `roomMap` reverts any field another window or Rust wrote into it
between the read and the save. `update(fn)` reads with `get_shell_state`, applies the partial `fn`
derives from that state, and writes with `replace_shell_state` guarded by the revision it read; on a
conflict it re-reads and re-runs `fn`, up to five attempts, then rejects. It runs in the window's
write queue, and its listeners hear the partial once, as for a save. Main window only, like the
migration write-back. The Devices → USB roster writes use it.

**`shell://state-changed` carries `{ set, remove, revision, writerId }` to every window.** The
facade feeds it to `onShellStateSaved` listeners, so a save in the popup reaches the main
window's listeners too. Rust writes through the same store and the same event
(`shell_state::patch_from_rust`, writer id `rust`, which no window holds as its own) — the
lighting transaction saves `lastOutputTargets` and `lightingMode` that way. A window's own write is delivered in-window as soon as the patch resolves,
as before, and its echo is dropped by `writerId`. Reads need no event: every `loadShellState`
asks Rust, so no window holds a stale copy of the file.

**The per-window write queue stays.** Commands run on the async runtime, so two invokes from one
webview are not ordered with each other. The queue keeps a window's patches in the order it issued
them. It no longer protects the merge; the Rust mutex does.

**Atomic writes, one `.bak`.** The new file is written to `shell-state.json.<pid>.tmp`, fsynced,
and renamed over the original. On Unix the directory is fsynced after the rename. Before the
rename, the file being replaced is copied to `shell-state.json.bak` through the same temp-and-
rename step, but only if it was itself good: loaded cleanly or written by us. A corrupt original
is never rotated into `.bak`, where it would destroy the last good copy. Nothing wrote a `.bak`
before this — plugin-store 2.4.5 `save` is a bare `fs::write`.

**Loading never fails.** A missing file is an empty state. Deleting the file is how a user
resets, so a missing file does not fall back to `.bak`. A file that is unreadable, is not JSON,
or holds a non-object under `shell-state` is logged, copied aside to `shell-state.json.corrupt`
for diagnosis, and replaced in memory by `.bak`. If `.bak` is also missing or bad, the state
starts empty and an error is logged.

**The format on disk did not change.** It is `{"shell-state": {...}}`, pretty-printed, exactly
what `serde_json::to_vec_pretty` of plugin-store's map produced. Any other top-level key is
carried through untouched. A downgrade to a plugin-store release reads the file as it always did
and ignores `.bak` and `.corrupt`. The first launch after an upgrade reads the plugin-era file
unchanged.

**One process per file.** The mutex serialises writers inside one process. Release builds are
single-instance. Two debug instances each keep their own copy, and the last one to write wins on
disk, as before.

## Gotchas

- **A wire union is checked for *equality* with the emitted set, not containment.** `verify:shell-contracts` harvests the codes Rust puts on each status shape and fails in both directions — an emitted code missing from the union, and a union member no producer emits. Containment alone is what let a declared-but-unemitted member sit in a union indefinitely.
- **A green verifier means every status code crossing the boundary is *declared*, not that it is *correct*.** It is a drift guard, not a coverage score. A code can be declared, returned, and still be the wrong code.
- **Hue credentials are not in `shell-state.json`.** They live in the OS keychain — see [`hue.md`](hue.md).
- **The `2 → 3` window-geometry migration derives a centre that sits ~14 px high on macOS, and that is accepted, not a bug.** The legacy `windowX/Y/Width/Height` fields stored the *inner* content size, but macOS adds ~28 px of title bar to the *outer* rect, and the derived centre can only use what was persisted. The bias self-corrects on the very next move or resize, because the rewritten `persistWindowState` path measures the outer size from then on. Do not "fix" the one-shot migration by reaching for a chrome height — it is platform-dependent and not knowable from persisted state alone.
- **A migration that drops records needs a reason it is safe.** The `1 → 2` step drops legacy `ZoneDefinition` records with a `console.warn` so the loss is auditable. That is only safe because the shape that produced them never shipped; no released build ever persisted one. A future migration cannot assume the same.
- **Retiring a stored key takes a step on both sides.** The `6 → 7` step deletes `startupEnabled`, `notificationsEnabled`, `roomMapBackgroundOpacity` and `lightingMode.targets` — safe to drop because nothing in either language read them (launch at login is the OS autostart entry's own state; the saved selection is `lastOutputTargets`). The TypeScript step alone is not enough for a nested key: Rust saves `lightingMode` as a read-modify-write that carries unknown fields through (`persist_mode` in `lighting_mode/outputs.rs`), so it strips `targets` itself, or an older file's copy would outlive the migration. A top-level key is also re-added by anything that merges `DEFAULT_SHELL_STATE` before writing, which is how `startupEnabled` kept reappearing as `false`.
- **`generate_handler![]` in `src-tauri/src/lib.rs` is the authoritative registration list.** A `#[tauri::command]` that is not in it does not exist at runtime, and the failure is an unhelpful "command not found" at the call site.
