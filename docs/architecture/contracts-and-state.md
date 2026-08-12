# Contracts, IPC, and persisted state

How the TypeScript and Rust halves agree on anything, and what survives a restart.

## Decisions

**Contract-first, always.** Every shape crossing the boundary is defined in
`src/shared/contracts/` **before** implementation. That directory is the source of truth — work
from it rather than from any summary, including this one. Run `pnpm verify:shell-contracts` after
touching either side; it checks that Rust handlers match the frontend definitions.

**Coded status, never a bare string.** A command returns a stable machine-readable status code
alongside the human-readable message. Never a bare string error, and never a code invented at the
call site — a code that exists in one place cannot be handled, translated, or searched for.

**Failures are never swallowed.** An empty `catch {}` is a defect here, not a shortcut. Log with
the `[LumaSync]` prefix. In Rust, return coded context through a status object or
`Result<_, String>`. For invalid external input, prefer an explicit fallback value over a silent
default — a silent default hides the fact that the input was wrong.

**State persists through Tauri `plugin-store`.** `shell-state.json` in the app data directory:
`~/Library/Application Support/com.lumasync.app/` on macOS, `%APPDATA%\com.lumasync.app\` on
Windows, `~/.local/share/com.lumasync.app/` on Linux. The store key is `SHELL_STORE_KEY` in
`src/shared/contracts/shell.ts`, and the Rust side reads the same file through
`app.path().app_data_dir()`.

**All frontend reads and writes go through the `shellStore.ts` facade**, and shape changes go
through `migrations.ts`. Stored keys follow `ShellState` in `shell.ts`.

**i18n keys are stable and scoped by feature.** EN and TR move together — a locale-parity test
enforces it, so a key added to one and not the other fails the suite.

## Gotchas

- **A green verifier means every status code crossing the boundary is *declared*, not that it is *correct*.** It is a drift guard, not a coverage score. A code can be declared, returned, and still be the wrong code.
- **Hue credentials are not in `shell-state.json`.** They live in the OS keychain — see [`hue.md`](hue.md).
- **The `2 → 3` window-geometry migration derives a centre that sits ~14 px high on macOS, and that is accepted, not a bug.** The legacy `windowX/Y/Width/Height` fields stored the *inner* content size, but macOS adds ~28 px of title bar to the *outer* rect, and the derived centre can only use what was persisted. The bias self-corrects on the very next move or resize, because the rewritten `persistWindowState` path measures the outer size from then on. Do not "fix" the one-shot migration by reaching for a chrome height — it is platform-dependent and not knowable from persisted state alone.
- **A migration that drops records needs a reason it is safe.** The `1 → 2` step drops legacy `ZoneDefinition` records with a `console.warn` so the loss is auditable. That is only safe because the shape that produced them never shipped; no released build ever persisted one. A future migration cannot assume the same.
- **`generate_handler![]` in `src-tauri/src/lib.rs` is the authoritative registration list.** A `#[tauri::command]` that is not in it does not exist at runtime, and the failure is an unhelpful "command not found" at the call site.
