# Window, tray, and UI shell

How the application presents itself. The shape here is a deliberate product decision, not a
framework default, and several things that look like oversights are the decision working.

## Decisions

**Tray-first.** The window is a place you visit, not where the app lives. Closing it hides to the
tray rather than quitting; day-to-day operation is switching mode and scene from the tray menu.
A change that assumes the window is always open is working against this.

**Two window modes with their own sizes.** `UI_MODE_SIZES` and `UI_MODE_MIN_SIZES` in
`src/shared/contracts/shell.ts`: full 900×620 (minimum 800×560), compact 320×480 (minimum
300×420). Compact is a real target, not a responsive afterthought — anything added has to survive
320 pixels of width.

**No full-screen blocking welcome wizard.** Onboarding is inline. The wizard is a mobile pattern
that fights the tray-first shape.

**The room map is not on the first-run path.** It is the advanced surface for people who want
per-edge placement tuned to their room, and the defaults work without it. First run must reach
working ambient lighting without ever mentioning it.

**Startup readiness is signalled by one log line.** `initWindowLifecycle` emits
`STARTUP_READY_MARKER` as its last statement, after window restore, `show()`, geometry persistence
and the tray. `scripts/verify/launch-smoke.mjs` reads the constant out of the source rather than
hardcoding it, so renaming the string is safe — but separating the constant from the call, or
removing either, breaks CI rather than silently passing.

## Gotchas

- **`onboarding` does not include the room map.** The two are separate surfaces despite both being setup-shaped.
- **Compact mode is not a narrow full mode.** It has its own layout under `settings/sections/compact/`; a component added only to the full layout simply does not exist for compact users.
- **`RoomMapEditor` is the largest single piece of UI in the codebase** — around 1,500 lines plus a `sections/room-map/` tree of roughly forty files — for a surface most users never open. Worth knowing before adding to it.
- **A toast's dismissal timer does not belong in the effect that raises it.** The USB-unplug branch in `App.tsx` rewrites `selectedOutputTargets` in the same commit that shows its toast, and that array is a dependency of the effect it lives in. The effect therefore tore itself down and cleared the timeout it had just scheduled, so the toast stayed on screen until something unrelated re-rendered it away. The timer now sits in its own effect keyed on the flag it clears — the shape any auto-dismissing surface should copy.
- **Frontend console output is bridged into the Rust log sink.** `src/main.tsx` wraps `console.log/info/warn/error` and forwards them into `tauri-plugin-log`, so frontend lines land in the same file as `log::info!`. The bridge is fire-and-forget (`void logInfo(...).catch(() => {})`), so a log call that loses the race with IPC becoming ready is dropped silently — **absence of a frontend log line never proves the code did not run.**
