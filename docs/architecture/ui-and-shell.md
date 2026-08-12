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

**Font faces are hand-declared, not `@fontsource/*` imports, and `font-display` is `block`.**
`src/fonts.css`. Every `@fontsource` bundle ships `swap`, and a `@font-face` descriptor can't be
overridden after the fact — `swap` paints a metrically-unrelated fallback first and reflows when the
woff2 lands, and this app opens a webview per calibration overlay, per twin overlay, and for the
control popup, so the same reflow would repeat on every one of them. `block` is correct because the
woff2 is bundled and served over the local asset protocol, well inside the block period, so text
paints once already in the right face. `optional` was rejected — it permanently drops a window to
the fallback face on a cold-launch miss, which is worse than the bounded wait `block` accepts.

**The compact/full mode transition is sequential, never a cross-fade.** `useUIMode.ts`: fade the
current content out, resize the window to the target mode, then mount the incoming layout and fade
it in. Pinning the incoming slot at its target size while the window is still animating toward that
size produces progressive clipping — a cross-fade needs both layouts live at once, and one of them
is always the wrong size for part of the transition. A second `switchUIMode` call while one is
already running is ignored rather than queued or interrupted.

**No full-screen blocking welcome wizard.** Onboarding is inline. The wizard is a mobile pattern
that fights the tray-first shape.

**The room map is not on the first-run path.** It is the advanced surface for people who want
per-edge placement tuned to their room, and the defaults work without it. First run must reach
working ambient lighting without ever mentioning it.

**Every shutdown path converges on one watchdog-guaranteed cleanup.** tao 0.35 does not register
`applicationShouldTerminate:`, so Cmd+Q cannot be intercepted directly — it arrives as `RunEvent::Exit`
and runs the same `kick_off_shutdown_and_die` as the tray Quit item, `WindowEvent::CloseRequested`,
and Ctrl+C. Cleanup runs on a worker thread (never the macOS main thread — running it inline from a
tray callback was the v1.5.1 deadlock) and a separate watchdog thread forces `process::exit(0)` after
4 seconds regardless of what cleanup is doing. That is what guarantees no `?E` zombie process: a
stuck `SCStream`/DTLS `Drop` can hang, but the process dies anyway.

**A hard exit bypasses Tauri's plugin `destroy()`, which leaks the single-instance socket.** Every
shutdown path here ends in `std::process::exit`, including the watchdog's forced one, so the
single-instance plugin's `/tmp/com_lumasync_app_si.sock` is never cleaned up by the plugin itself.
The next launch's `connect()` succeeds against the stale socket and silently `exit(0)`s against it —
looking like the app failed to start. `kick_off_shutdown_and_die` removes the socket explicitly
before exiting so a normal quit starts the next launch clean; a killed dev process (`pkill -9`) skips
that path entirely, which is why the debug recipe in `CLAUDE.md` runs `rm -f` on the socket before
every restart. Debug builds skip the single-instance plugin altogether for the same reason — the
common `cargo build`/hot-reload hard-exit would otherwise leak it on every iteration. Release keeps
the plugin on: tray-first UX needs the single-instance contract, and the explicit socket cleanup
above covers the hard-exit path there too.

**Startup readiness is signalled by one log line.** `initWindowLifecycle` emits
`STARTUP_READY_MARKER` as its last statement, after window restore, `show()`, geometry persistence
and the tray. `scripts/verify/launch-smoke.mjs` reads the constant out of the source rather than
hardcoding it, so renaming the string is safe — but separating the constant from the call, or
removing either, breaks CI rather than silently passing.

## Gotchas

- **`onboarding` does not include the room map.** The two are separate surfaces despite both being setup-shaped.
- **Native fullscreen draws a second title bar over the custom amber one.** Tauri/tao has an open upstream bug (`tauri-apps/tauri#5115`, `tao#548`) that re-applies the system `NSTitledWindow` styleMask during the fullscreen transition, so a delegate patch loses the race. `macos_window.rs` forbids native fullscreen instead of fighting it: `NSWindowCollectionBehavior::FullScreenNone` removes the fullscreen pathways, and the zoom button is separately disabled so the green dot renders as inert rather than a live control with no effect.
- **Compact mode is not a narrow full mode.** It has its own layout under `settings/sections/compact/`; a component added only to the full layout simply does not exist for compact users.
- **`RoomMapEditor` is the largest single piece of UI in the codebase** — around 1,500 lines plus a `sections/room-map/` tree of roughly forty files — for a surface most users never open. Worth knowing before adding to it.
- **Pairing a USB strip adds it as an output target by itself.** Without that, the Lights output toggle stays off until a WebView reload even though the StatusBar USB pill has already flipped to OK — pairing is the intent, so nothing further should be asked of the user. The auto-add writes state and persistence directly instead of calling `handleOutputTargetsChange`: that helper's delta-start branch is gated on a running mode, so on a cold-launch pair it would do exactly the same two things anyway, and if a mode *is* already running it would race the bootstrap pipeline for a target bootstrap is concurrently hydrating from `lastOutputTargets`. Let the next deliberate user action drive delta-start.
- **A toast's dismissal timer does not belong in the effect that raises it.** The USB-unplug branch in `App.tsx` rewrites `selectedOutputTargets` in the same commit that shows its toast, and that array is a dependency of the effect it lives in. The effect therefore tore itself down and cleared the timeout it had just scheduled, so the toast stayed on screen until something unrelated re-rendered it away. The timer now sits in its own effect keyed on the flag it clears — the shape any auto-dismissing surface should copy.
- **The twin overlay neutralises its background synchronously, before React mounts.** It is created transparent and visible, but `index.html`'s bundled body gradient paints an opaque background before anything renders, so `main.tsx` clears html/body/#root backgrounds ahead of bootstrap, i18n, and React — otherwise the twin flashes an opaque full-screen frame on open. `LedTwinOverlay`'s own effect repeats the same clear as belt-and-suspenders.
- **The twin overlay gets `TwinErrorBoundary`, not `GlobalErrorBoundary`.** Its fallback renders nothing. The twin is a click-through overlay covering a full display — an opaque fallback card there would blanket the screen with something the user cannot dismiss, so a render throw in the twin must degrade to invisible rather than to a visible error state. The main window and the (opaque) control popup keep the normal amber-card `GlobalErrorBoundaryWithI18n`.
- **Frontend console output is bridged into the Rust log sink.** `src/main.tsx` wraps `console.log/info/warn/error` and forwards them into `tauri-plugin-log`, so frontend lines land in the same file as `log::info!`. The bridge is fire-and-forget (`void logInfo(...).catch(() => {})`), so a log call that loses the race with IPC becoming ready is dropped silently — **absence of a frontend log line never proves the code did not run.**
