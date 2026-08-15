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

**Every launch opens compact, whatever the last session used.** The persisted `uiMode` is read but
deliberately ignored at startup, so the app always appears with the same small tray-style footprint.
That is only flash-free because the Tauri window is *created* at compact dimensions in
`tauri.conf.json` (320×480, `visible: false`) and `tauri-plugin-window-state` is registered with
`skip_initial_state("main")` — the plugin restores nothing, and `windowLifecycle.ts` restores
position alone from our own store. Letting the plugin restore size or visibility brings back a
visible big→compact flash on every cold start.

**Background polls are visibility-aware, and that is a repo-wide convention, not a per-hook
choice.** The Hue reachability, readiness, and runtime-status loops and `useRuntimeTelemetry` all
use a recursive `setTimeout` rather than `setInterval`, pause while `document.visibilityState` is
`hidden`, and re-arm with an immediate tick on `visibilitychange`. The tray window can sit hidden
for hours with the React tree mounted, so an unconditional interval keeps firing bridge requests
nobody can see; the immediate resume tick is what makes a chip look fresh the instant the window
comes back. A new poll that skips this is a regression even though nothing will fail.

**Lighting-mode dispatch is deduplicated by payload signature and rate-capped at 50 Hz.** Two layers,
and they guard different things. The signature is content-based with sorted keys, because
`hydrateModePayload`'s spread chain produces different key insertion orders for identical payloads
and a naive comparison then reports every fire as new. The cooldown is a backstop against any
un-traced 50–60 Hz source: the Rust handler is idempotent for settings updates but takes the full
worker tear-down and restart whenever one of its own equality gates misses, so a few stray
mismatches a second visibly stutter the strip. Legitimate drag commits are already throttled to
20 Hz upstream, so the cap costs nothing real.

**Quick adjustments bypass the mode-transition lock-gate.** A quick adjustment is a config nudge
within the same mode kind — brightness, colour — and it is idempotent, so it never needs to wait for
a transition. Gating them behind the lock queued every drag tick, and on release the queued payload
started a *new* slow-path transition (the kind had changed while it waited) which the next burst of
ticks immediately queued behind, leaving `isModeTransitioning` stuck true and every dock control
disabled. Related: a quick adjustment must not require the selected and active target sets to match
either. Falling through to the full transition path just to reconcile targets flips
`isModeTransitioning`, which disables the slider mid-drag and makes the browser release pointer
capture — the symptom is a drag that dies after one commit.

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
- **A popover in compact has to be portalled and positioned from a measured height.** `.lm-compact { overflow: hidden }` over `.lm-compact-body { overflow: auto }` clips anything anchored inside the layout, so the colour picker renders through a portal into `document.body` and computes its position from the trigger's rect, refreshed on resize and scroll. Height then has to be *measured*, not estimated: the recent-colours strip mounts lazily and the picker grows after first paint, and at 320×480 the difference is the popover hanging off-screen. A `useLayoutEffect` re-measure follows the first paint and a `ResizeObserver` catches later growth, so the visible position is always the second pass.
- **`RoomMapEditor` is the largest single piece of UI in the codebase** — around 1,500 lines, at the head of a `features/room-map/` tree of roughly twenty more files — for a surface most users never open. Worth knowing before adding to it. It is a settings *section* that lives in its own feature module, the same way `CalibrationPage` does: `SettingsLayout` is a router, not an owner.
- **Pairing a USB strip adds it as an output target by itself.** Without that, the Lights output toggle stays off until a WebView reload even though the StatusBar USB pill has already flipped to OK — pairing is the intent, so nothing further should be asked of the user. The auto-add writes state and persistence directly instead of calling `handleOutputTargetsChange`: that helper's delta-start branch is gated on a running mode, so on a cold-launch pair it would do exactly the same two things anyway, and if a mode *is* already running it would race the bootstrap pipeline for a target bootstrap is concurrently hydrating from `lastOutputTargets`. Let the next deliberate user action drive delta-start.
- **Bootstrap must not strip `usb` from the output targets when the live snapshot says disconnected.** Cold launch races `tryAutoReconnect`, which waits out the ~2 s bootloader settle before it can report anything; roughly a quarter of starts finish bootstrap first, see `connected: false`, and drop the user's persisted USB target. Auto-reconnect then succeeds and emits `connected: true`, but the hot-plug reconciler's membership check no longer matches, so the output stays silently off until the user toggles it by hand. The target is kept regardless of the snapshot — `modeGuard` already renders the disabled state from `isConnected`, so nothing is hidden from the user. The separate "was USB physically present last time we looked" flag is *not* part of this and must keep tracking the snapshot, or the false→true transition re-fires on every cold start.
- **A structurally unavailable USB port does get dropped from the targets, but only for two codes.** `PORT_UNSUPPORTED` and `PORT_NOT_FOUND` mean the port will not work for the rest of this session — typically a phantom endpoint the allowlist now rejects — and leaving `usb` selected sends every later `set_lighting_mode` into the Rust gate, which returns `DEVICE_NOT_CONNECTED` silently. From the user's seat, Ambilight does nothing. Transient codes (`CONNECT_TIMEOUT`, `CONNECT_IO_ERROR`, `CONNECT_FAILED`) must *not* trigger this: stripping the target on a retryable failure loses a setting the user chose. The boot path writes the surviving targets directly rather than through `handleOutputTargetsChange`, whose delta-stop branch would try to stop a mode that is not running yet.
- **A toast's dismissal timer does not belong in the effect that raises it.** The USB-unplug branch in `App.tsx` rewrites `selectedOutputTargets` in the same commit that shows its toast, and that array is a dependency of the effect it lives in. The effect therefore tore itself down and cleared the timeout it had just scheduled, so the toast stayed on screen until something unrelated re-rendered it away. The timer now sits in its own effect keyed on the flag it clears — the shape any auto-dismissing surface should copy.
- **The twin overlay neutralises its background synchronously, before React mounts.** It is created transparent and visible, but `index.html`'s bundled body gradient paints an opaque background before anything renders, so `main.tsx` clears html/body/#root backgrounds ahead of bootstrap, i18n, and React — otherwise the twin flashes an opaque full-screen frame on open. `LedTwinOverlay`'s own effect repeats the same clear as belt-and-suspenders.
- **The twin overlay gets `TwinErrorBoundary`, not `GlobalErrorBoundary`.** Its fallback renders nothing. The twin is a click-through overlay covering a full display — an opaque fallback card there would blanket the screen with something the user cannot dismiss, so a render throw in the twin must degrade to invisible rather than to a visible error state. The main window and the (opaque) control popup keep the normal amber-card `GlobalErrorBoundaryWithI18n`.
- **Windows click-through is a race, so the overlay sweeps for children more than once.** `build_transparent_overlay` sets `WS_EX_TRANSPARENT | WS_EX_LAYERED` on every child HWND, because WebView2's host window does not inherit the flag from its parent and captures the mouse without it. But WebView2 creates those children on its own schedule — the render-widget child appears when content loads, after `build()` has returned — so the single sweep on the next line can find nothing to mark. `schedule_clickthrough_resweeps` repeats it on a short decaying schedule, marshalled onto the main thread; the ex-style bits are idempotent, so a sweep that finds an already-marked window is free. This is the suspected mechanism behind the Windows report of the overlay making the whole app unclickable, and it is a Windows-only code path: nothing in CI or on the other two platforms exercises it.
- **The tray's Close Overlays item is a backend-only rescue, and that is the point.** The overlays are `closable(false)`, `skip_taskbar(true)` and undecorated, so one that captures input rather than passing it through leaves no title bar, no taskbar button, and nothing clickable underneath. Every other tray item emits an event and lets the frontend act; `close_all_overlays` instead destroys the windows from Rust and shows the main window unconditionally — not through `restore_main_after_preview`, which by design only acts when the preview is what hid it. Depending on a round trip through the webview is exactly the assumption a wedge invalidates.
- **Frontend console output is bridged into the Rust log sink.** `src/main.tsx` wraps `console.log/info/warn/error` and forwards them into `tauri-plugin-log`, so frontend lines land in the same file as `log::info!`. Plugin-log records with a caller use targets shaped like `webview:<location>`; fern only inherits `level_for` filters across Rust's `::` separator, so the debug logger must keep `Info` as its global floor rather than relying on `level_for("webview", Info)`. A rejected bridge call is reported once through the original console.
