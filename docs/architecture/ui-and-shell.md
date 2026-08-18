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
- **Boot restores the persisted UI mode, and the "flash" that once forbade it was never possible.** `restoreWindowState` used to carry a note that writing a persisted full-mode size at boot "would produce a visible big→compact flash before React mounts". The main window is created with `"visible": false` and nothing in Rust shows it, so the only `show()` is the one in `initWindowLifecycle` — after the size and position are applied. There was nothing on screen to flash. Boot now restores position at the created (compact) size, then calls `resizeToMode(mode, { animate: false })` to grow around that centre, reusing the manual-toggle path rather than reimplementing the monitor clamp and full-size memory. Two ordering rules hold it together: `sink.setUIMode` runs *before* `initWindowLifecycle`, or the shell appears full-sized still rendering compact; and `animate: false` must bypass `animateWindowRect` rather than pass it a zero duration, which would make `t` NaN and spin the loop forever.
- **The Windows child-HWND sweep may add `WS_EX_TRANSPARENT` and must never add `WS_EX_LAYERED`.** WebView2's children (`Chrome_WidgetWin_*`, `Chrome_RenderWidgetHostHWND`, `Intermediate D3D Window`, all owned by `msedgewebview2.exe`) do not inherit the parent's ex-style, which is why `propagate_transparent_to_children` exists at all. But a window handed `WS_EX_LAYERED` through `SetWindowLong` "will not become visible until `SetLayeredWindowAttributes` or `UpdateLayeredWindow` has been called for this window" (Win32, *Layered Windows*), and nobody calls either on a window we do not own — so ORing that bit onto the WebView2 subtree makes it paint nothing. The overlay opens blank. `schedule_clickthrough_resweeps` then repeats the marking on a decaying schedule, which turned a race into a certainty rather than causing it. The sweep now sets `WS_EX_TRANSPARENT` alone, checks `SetWindowLongPtrW` against `SetLastError(0)`/`GetLastError` (a cross-process/UIPI refusal must be visible, and the call returns 0 both for failure and for "previous value was 0"), and follows it with `SetWindowPos(SWP_FRAMECHANGED)`, because an ex-style written this way is cached until a frame change is forced. The bits stay idempotent, so a re-sweep that finds an already-marked child is free.
- **Hit-testing is already covered by the top-level, so the child sweep is a belt, not the braces.** `set_ignore_cursor_events(true)` has tao set `WS_EX_TRANSPARENT | WS_EX_LAYERED` on the *outer* window and apply it with `SetWindowPos(SWP_FRAMECHANGED)`; a top-level that is both layered and transparent is skipped by hit-testing entirely, so the mouse never reaches its children in the first place. That top-level demonstrably stays visible with `WS_EX_LAYERED` on it — tao never calls `SetLayeredWindowAttributes` either, and layered+transparent Tauri overlays render on Windows in the field — while a layered *child* is the case the Chromium/CEF "blank child window" reports describe. The CI probe settled the observable half on 2026-08-18: with the bit on the children the whole display goes solid black, without it the overlay draws over the desktop, and hit-testing falls through in both cases — so the bit was the whole blank-overlay fault and never bought any click-through. Why a layered top-level renders and a layered child does not is still a reading (DWM composition carrying the former), not a measurement. `LUMASYNC_WIN_OVERLAY_SWEEP` exists to settle which half is actually load-bearing on real hardware: `off` (no child touched), `transparent` (default), `transparent+layered` (reproduces the ≤1.5.5 behaviour). It is read once per process through a `OnceLock` and governs the initial sweep and every re-sweep alike.
- **A transparent overlay must not set `background_color`.** `WebviewWindowBuilder::background_color` writes both layers, and on Windows the *window* layer drops the alpha channel: tao stores the RGB and answers `WM_ERASEBKGND` with `CreateSolidBrush` + `FillRect`, so `Color(0, 0, 0, 0)` erases the client area to opaque black. The webview layer ignores the value anyway — wry forces `(0, 0, 0, 0)` whenever `transparent` is set — so the call could only ever hurt. `focusable(false)` is set instead, which is `WS_EX_NOACTIVATE` on Windows and `canBecomeKeyWindow: NO` on macOS; a click-through overlay has nothing to type into and must never take activation.
- **The `OverlayState` lock must not span `build()`.** `open_display_overlay` reads the previous label and computes the next one under the lock, releases it, does the window work, then re-locks to commit — hence the split between `run_overlay_open_transition` (sequencing, pure) and `apply_overlay_open_transition` (bookkeeping, pure). Holding the guard across `WebviewWindowBuilder::build()` deadlocks the main thread on Windows: wry/webview2-com runs a nested message pump inside `build()` (`wait_with_pump`), which dispatches queued tray-menu and IPC messages re-entrantly, and `std::sync::Mutex` is not reentrant. The tray's Close Overlays rescue cannot recover from that, because it needs the same main thread.
- **Windows overlay behaviour is unverifiable anywhere but Windows.** Nothing in CI or on the other two platforms enters these code paths, and the Rust cross-check dies in `aws-lc-sys` on macOS, so the first compile of a change here is the `windows-latest` CI job. The bench recipe, in order: **T0** — an external HWND probe over the overlay's tree, dumping the ex-style in hex plus `GetLayeredWindowAttributes` for the top-level and every child, and `WindowFromPoint` over the overlay area. **T2** — three runs with `LUMASYNC_WIN_OVERLAY_SWEEP` set to `off`, `transparent`, `transparent+layered`, comparing whether the overlay paints and whether clicks reach the desktop underneath. **T3** — the calibration overlay (which leaves the shell on screen) against the LED preview (which hides it), since only the second can look like "the app disappeared". **T4** — while wedged, does the tray menu open at all? If it does not, the main thread is blocked and the fault is the lock, not input routing. T0 and T2 no longer need a human: the `windows-latest` CI job runs them and gates on the result, keeping the `overlay-smoke-windows` artefact — see [`build-and-release.md`](build-and-release.md#the-windows-overlay-probe).
- **The tray's Close Overlays item is a backend-only rescue, and that is the point.** The overlays are `closable(false)`, `skip_taskbar(true)` and undecorated, so one that captures input rather than passing it through leaves no title bar, no taskbar button, and nothing clickable underneath. Every other tray item emits an event and lets the frontend act; `close_all_overlays` instead destroys the windows from Rust and shows the main window unconditionally — not through `restore_main_after_preview`, which by design only acts when the preview is what hid it. Depending on a round trip through the webview is exactly the assumption a wedge invalidates.
- **Only a user-driven resize records the window size, and it records the *inner* rect.** `persistWindowState` saved nothing but the centre, and `lastFullSize` was written in exactly one place — `resizeToMode`, when *leaving* full. So dragging the window edge was never persisted: a reload restored the size from the last compact↔full toggle and the window snapped back. The debounced `onResized` path now captures it, but `resizeToMode` passes `captureSize: false`, because at boot it runs while the window is still at its created compact size and capturing there wrote 320×452 over the size it was in the middle of restoring — the existing "re-entering full does not overwrite the remembered full size" case catches exactly that, and did. The stored value is logical **inner** px to match what `resizeToMode` reads back; persisting the outer rect would restore a window one title bar taller each cycle. Compact is deliberately not recorded — it is a fixed tray popup, and `UI_MODE_SIZES.compact` stays its size.
- **A target window size is clamped down to the work area, and never up.** `ensureWindowRectOnScreen` only ever moved a rect — width and height passed through untouched — so the 900×620 full default, and any `lastFullSize` remembered from a bigger display, were applied to whatever screen the window happened to be on. Too tall and the bottom edge is off-screen with the resize grip on it, so nothing the user can do brings it back. `fitSizeToWorkArea` shrinks the target in `resizeToMode`, and the same clamp applies to `setMinSize`: a floor larger than the screen is worse than none, since the OS then refuses every resize that would fit. It reads `Monitor.workArea`, not `Monitor.size`, so a tall taskbar counts — and falls back to full bounds when a platform reports no work area, because a missing dock inset must not silently turn the clamp into a no-op. Growing is deliberately not done: since #286 the full size the user chose is remembered, so a small default on a large display is answered once by the user rather than guessed every launch. Note the position clamp still uses full monitor bounds; `WINDOW_EDGE_MARGIN = 0` is deliberate there and left alone.
- **The App content slot is a flex column, and an in-flow banner above a `height: 100%` layout is why.** `OnboardingFlow` and `SettingsLayout` are siblings inside the `absolute inset-0` slot, and both compact (`.lm-compact { height: 100% }`) and full (`h-full`) size themselves to the whole slot. As a plain block column the banner therefore pushed the layout down by its own height and the backdrop's `overflow-hidden` clipped exactly that much off the bottom — above the layout's own scroll container, so the lost strip was unreachable rather than scrollable. Measured in Chromium at 320×480: a 162 px banner took the entire compact scene row 78 px past the visible edge; full mode lost 58–73 px. The column plus a `min-h-0 flex-1` box around the layout makes the two share the height instead. The banner's own `flex-shrink: 0` is part of it — without it the banner gives up height rather than letting the layout scroll. Separately, the banner wraps its actions onto a second row below 480 px: unwrapped it is 132–162 px against the `< 80 px` this surface is documented to cost, and only compact ever reaches that width since full floors at 800. None of this is assertable in `happy-dom`, which has no layout engine, so `App.test.tsx` guards the structure and this entry carries the numbers.
- **Frontend console output is bridged into the Rust log sink.** `src/main.tsx` wraps `console.log/info/warn/error` and forwards them into `tauri-plugin-log`, so frontend lines land in the same file as `log::info!`. Plugin-log records with a caller use targets shaped like `webview:<location>`; fern only inherits `level_for` filters across Rust's `::` separator, so the debug logger must keep `Info` as its global floor rather than relying on `level_for("webview", Info)`. A rejected bridge call is reported once through the original console.
