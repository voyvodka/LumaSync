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

**Per-window bundles.** Every window loads the same `index.html`, so everything `main.tsx` imports
statically is parsed by the main window, the control popup, and one twin overlay per display. The
entry holds only React, i18next, the console bridge, the error boundaries, and the label switch;
each window's root (`App`, `ControlPopupApp`, `LedTwinOverlay`) is a dynamic `import()` started
before the language read, so the chunk and the shell-state IPC load in parallel rather than one
after the other. Inside the main window, `SettingsLayout` splits out the
three full-only sections that outweigh the rest of the shell — `CalibrationPage`, `DeviceSection`,
`RoomMapEditor` — through `preloadableComponent` (`src/shared/lib/`). Compact mode never renders
them, so it never fetches them; full mode warms all three on idle after it paints, so a tab switch
rarely meets the blank `SectionPlaceholder`. `LightsSection` and `SystemSection` stay in the `App`
chunk: Lights is the page full mode opens on, and neither is big enough to be worth a first-paint
wait. Locale catalogues load per language (`LOCALE_LOADERS` in `i18n.ts`); a switch fetches the
other catalogue before `changeLanguage`, so no frame renders raw keys. A TR window does not fetch
the EN fallback — key parity is a CI gate, so the fallback is never reached. The label switch lives
in `main.tsx` alone, and `scripts/verify/window-grants.mjs` follows `import()` as well as static
imports, or a lazy section would drop out of the main window's required grants.

**Shell state reaches sections through stores.** `App.tsx` used to hand `SettingsLayout` every
lighting value, the navigation state and the updater's, two of them as fresh closures, so the
layout's `memo` never held: every render of the shell — a Hue poll, a runtime revision, each
download-progress event — re-rendered the whole page. Now three stores carry it, each a
`createStore` (`src/shared/lib/store.ts`) read through `useSyncExternalStore` with a selector, so a
consumer re-renders only when its own slice changes:

- *Lighting control* (`mode/state/lightingControl.tsx`): the orchestrator's view of the runtime
  snapshot plus the non-Hue inputs of the output gate, and the actions — change mode (an apply, or
  a coalesced retune), change outputs, release Hue, save calibration.
- *Navigation* (`shell/navigationStore.tsx`): owns the active section and a notice's Devices
  category; mirrors `uiMode`, which `useUIMode` keeps owning because it owns the fade.
- *Updater* (`updater/UpdaterProvider.tsx`): `useAutoUpdater` sits in a provider *above* the shell,
  so a progress event re-renders the provider and `UpdateModalHost` and stops there; the shell
  reads only the status, the failed-check notice and whether the modal is up.

Each provider wraps its actions with `useStableHandlers`, so the actions object never changes
identity and the caller may pass fresh closures. A hook-owned value is mirrored with
`useMirroredStore`, which writes in a layout effect: subscribers re-render in the same frame,
before paint. Every section in `SettingsLayout` is a memoised panel that selects its own slices;
the layout itself takes only the Hue status, as props, until the Hue health store replaces the
shell's Hue polls. `SettingsLayout.renders.test.tsx` and the render-boundary tests in
`src/__tests__/` count renders and fail if a boundary leaks. A value put into a store must keep its
identity between renders when unchanged — `localSink` is memoised for exactly this — or every
reader of it re-renders.

**Stylesheet layers.** `src/styles.css` is an ordered import list over `src/styles/`: tokens and
the element rules go into Tailwind's `base` layer, every `lm-*` feature file into `components`.
`theme.css` maps the colour tokens and `--lm-mono` into `@theme inline`, so a utility names the
token — `text-ink`, `bg-panel-2`, `ring-amber/60`, `font-mono` — and still compiles to
`var(--lm-*)`; `verify:design-tokens` rejects the old arbitrary `[var(--lm-*)]` form where a named
utility exists.
Layer order is theme < base < components < utilities and it is decided before specificity, so a
utility on an element beats any `lm-*` rule that sets the same property — `.lm-x .lm-y:hover`
included. That is the point: a utility is the local override, with no `.lm-x.hidden`-style
counter-rule needed. The cost is the reverse case. A container rule that sizes its children
(`.lm-hue-repair svg { width: 13px }`) cannot beat a size utility on the child, so shared icons that
sit in such containers declare their default size as `width`/`height` attributes, which any
stylesheet rule overrides. Within a layer, source order still decides equal-specificity ties,
which is why the import list is kept in cascade order. `stylesheetSanity.test.ts` fails on a
feature file imported without a layer. `GlobalErrorBoundary.css` stays unlayered: it is loaded by its
component rather than through this list, and unlayered it cannot lose to a components-layer rule
on the `lm-settings-group` card it sits on, whatever order the bundler emits.

**Selection state is styled from ARIA where the element carries it.** A tab's selected look is
`[aria-selected="true"]`, a toggle's `[aria-pressed="true"]`, a radio's `[aria-checked="true"]`, the
device rail's `[aria-current="page"]` — the attribute a screen reader announces is the same one the
stylesheet reads, so the two cannot disagree. Where the element has no such attribute, the class is
`is-on`; `is-sel` and `is-selected` are gone. `is-active` survives only for things that are not
selection: a step tracker's current step and the status bar's tone scale.

**The compact/full mode transition is sequential, never a cross-fade.** `useUIMode.ts`: fade the
current content out, resize the window to the target mode, then mount the incoming layout and fade
it in. Pinning the incoming slot at its target size while the window is still animating toward that
size produces progressive clipping — a cross-fade needs both layouts live at once, and one of them
is always the wrong size for part of the transition. A second `switchUIMode` call while one is
already running is neither queued nor allowed to interrupt: it gets the running transition's
promise and resumes when that one settles.

**`useUIMode` is the only frontend caller of `resizeToMode` after boot.** A section change from
compact (a notice's deep-link, a CTA, ⌘,) used to resize the window itself and then set the mode,
while ⌘, also called `switchUIMode` — two resize animations raced on the same window, and the
section change skipped the fade entirely. Anything that needs full mode awaits `switchUIMode("full")`
and sets its section before the await, so the full layout mounts on the right page. The boot restore
in `initWindowLifecycle` is the one other caller; it runs before React exists.

**No wait in that chain may depend on animation frames alone.** The webview stops firing
`requestAnimationFrame` while the window is hidden, occluded, or behind a locked screen. The resize
animator's per-frame wait and the double paint before the fade-in both awaited rAF unbounded, so a
toggle made in that state — tray, ⌘, or a title-bar click as the window was covered — never
finished: the lock stayed held, the content sat at opacity 0 with pointer events and shortcuts off,
and every later toggle was dropped until frames resumed. Both now go through `waitForFrames` in
`frameWait.ts`, which races the frames against a 250 ms timer and cancels the loser. That is far
above a visible double paint (~33 ms, ~66 ms at a throttled 30 Hz), so it does not win while the
window is on screen; if a janky frame does let it win, the fade-in only starts a frame early from a
container that is already at opacity 0, so nothing flashes. The animator's progress is wall-clock,
so a timer-paced loop still lands on the final rect. Timers can themselves be throttled while
hidden, but they fire; rAF does not. The opacity waits already had their own safety timeout. A
rejected resize is logged and fades the old layout back in instead of leaving it invisible.

**The window-state plugin restores nothing; our own store does.** The Tauri window is *created* at
compact dimensions in `tauri.conf.json` (320×480, `visible: false`) and `tauri-plugin-window-state`
is registered with `skip_initial_state("main")`. `windowLifecycle.ts` then restores position and the
persisted mode's size from `shell-state.json` before its one `show()` — see the boot-restore gotcha
below. Letting the plugin restore size or visibility would show and size the window before the
bootstrap has, and two restorers disagreeing is a visible jump on every cold start.

**Background polls are visibility-aware, and that is a repo-wide convention, not a per-hook
choice.** The Hue reachability, readiness, and runtime-status loops and `useRuntimeTelemetry` all
use a recursive `setTimeout` rather than `setInterval`, pause while `document.visibilityState` is
`hidden`, and re-arm with an immediate tick on `visibilitychange`. The tray window can sit hidden
for hours with the React tree mounted, so an unconditional interval keeps firing bridge requests
nobody can see; the immediate resume tick is what makes a chip look fresh the instant the window
comes back. A new poll that skips this is a regression even though nothing will fail.

**Every window's lighting choices go to one Rust transaction.** The main window, the LED control
popup, the tray and the launch restore all send `apply_outputs`, and every window renders the same
runtime snapshot (`useLightingRuntime`). The ordering rules, the Hue start and stop, the saving and
the launch's wait for a held Hue area are Rust's ([`lighting-transaction.md`](lighting-transaction.md));
what is left in the main window's orchestrator is the notice copy, its timers, and the
screen-recording preflight. The frontend orchestrator it replaced kept those rules in a React hook,
reachable only through a mock of the backend, and the popup never followed them.

**A nudge within the running kind is a retune: coalesced, deduped, and never a transition.** A
brightness or colour drag commits at 20 Hz. Each commit goes to `retune_lighting`, which waits for
no transition, through `retuneCoalescer.ts`: one call in flight, the newest value next, and a value
equal to the last one sent — compared with sorted keys, since a re-render rebuilds the same payload
in another key order — is not sent at all. The old path sent each commit, and every settings panel
re-dispatched the whole mode on a change; on hardware that was 68 `set_lighting_mode` calls in one
session, twenty of them in a second. A saved setting the running mode reads (display, preset,
colour correction, output settings, room map) is now re-applied by Rust once the save settles,
whichever window saved it (`lighting-transaction.md`, "Settings refresh"). A kind the newest choice is still bringing up counts as
running, so a drag during a start retunes rather than choosing again.

**`isModeTransitioning` is this window's own choices, not the snapshot's phase.** It disables the
mode buttons and the brightness slider, and disabling a slider mid-drag makes the browser release
pointer capture — the symptom is a drag that dies after one commit. The snapshot's phase also moves
for a settings refresh Rust runs on its own, which must never do that.

**A newer choice supersedes; it does not queue.** The frontend used to queue a kind change made
during a transition and replay it from a closure that still held the pre-transition state, so an
Off pressed during a start from Off read "nothing running" and left the start's worker going. The
transaction writes each request as the intent on arrival and reconciles to the newest one, so an
overtaken choice leaves nothing to undo.

**No full-screen blocking welcome wizard.** Onboarding is inline. The wizard is a mobile pattern
that fights the tray-first shape.

**The room map is not on the first-run path.** It is the advanced surface for people who want
per-edge placement tuned to their room, and the defaults work without it. First run must reach
working ambient lighting without ever mentioning it.

**Every shutdown path converges on one watchdog-guaranteed cleanup.** `src-tauri/src/shutdown.rs`
owns it: the tray Quit item, Ctrl+C in dev, Cmd+Q, a programmatic exit or restart, and the Windows
update installer all go through the same `ShutdownCoordinator`. The first trigger wins and later ones
are logged and ignored. Cleanup runs on a worker thread (never the macOS main thread — running it
inline from a tray callback was the v1.5.1 deadlock) in three bounded steps (lighting 1.5 s, Hue by
3.3 s, sink), and a separate watchdog thread forces the exit after 4 seconds regardless of what
cleanup is doing. That is what guarantees no `?E` zombie process: a stuck `SCStream`/DTLS `Drop` can
hang, but the process dies anyway. Exactly one thread ends the process; whoever loses that claim
parks.

- *Cmd+Q holds the main thread.* tao 0.35 does not register `applicationShouldTerminate:`, so Cmd+Q
  cannot be intercepted — it arrives as `RunEvent::Exit` from inside `applicationWillTerminate`, and
  AppKit calls `exit()` the moment that callback returns. The handler used to kick the cleanup off and
  return, so the process died under the cleanup thread: the Hue step and everything after it never
  ran, whatever the comment beside it claimed. It now waits on the cleanup (bounded by the watchdog)
  and ends the process itself. It still never returns into Tauri's teardown, which runs on the main
  thread after `applicationWillTerminate` and is where an `SCStream` drop was seen to deadlock; the
  cleanup does not need the main thread (the capture stream's stop is detached onto its own thread).
- *`RunEvent::ExitRequested` is prevented, and our cleanup ends the process.* Tauri ignores
  `prevent_exit` for its restart code, so a restart (`relaunch()` from `GlobalErrorBoundary`, the
  updater after an install) goes on to `RunEvent::Exit` and relaunches from the main thread there.
  It has to: Tauri's plugins release the single-instance lock on that event, and a new process
  spawned before it would hand its launch to the dying one and exit. The cleanup thread therefore
  never relaunches on its own. A relaunch drops `--tray`, since it is always one the user asked for.
- *The Windows installer runs the cleanup inline.* The updater plugin launches the installer and
  calls `process::exit` itself, so `on_before_exit` runs the same three steps synchronously, without
  a watchdog to race it. The installer relaunches the app.

**An update restarts the app on macOS and Linux.** There the plugin replaces the bundle (or
AppImage) in place and returns, and nothing used to restart it: the modal sat on "Installing". The
install command now calls `request_restart`, which takes the restart path above.

**A login launch stays in the tray.** Autostart passes `--tray`; `get_launch_context` reports it
and `initWindowLifecycle` restores the geometry but skips its one `show()`, so the first tray click
opens the window where it was left. The startup marker is still logged. A failed read shows the
window: an app that never appears is worse than one that opens at login. A second launch carrying
`--tray` (the autostart entry firing over an instance already running) does not raise the window
either. On macOS a Dock-icon click (`RunEvent::Reopen`) shows and focuses the main window, like the
tray's Open Settings.

**A hard exit bypasses Tauri's plugin `destroy()`, which leaks the single-instance socket.** Every
shutdown path here ends in `std::process::exit`, including the watchdog's forced one, so the
single-instance plugin's `/tmp/com_lumasync_app_si.sock` is never cleaned up by the plugin itself.
The next launch's `connect()` succeeds against the stale socket and silently `exit(0)`s against it —
looking like the app failed to start. The shutdown's exit removes the socket explicitly
before exiting so a normal quit starts the next launch clean; a killed dev process (`pkill -9`) skips
that path entirely, which is why the debug recipe in `AGENTS.md` runs `rm -f` on the socket before
every restart. Debug builds skip the single-instance plugin altogether for the same reason — the
common `cargo build`/hot-reload hard-exit would otherwise leak it on every iteration. Release keeps
the plugin on: tray-first UX needs the single-instance contract, and the explicit socket cleanup
above covers the hard-exit path there too.

**Startup readiness is signalled by one log line.** `initWindowLifecycle` emits
`STARTUP_READY_MARKER` as its last statement, after window restore, `show()`, geometry persistence
and the close-to-tray hint. `scripts/verify/launch-smoke.mjs` reads the constant out of the source rather than
hardcoding it, so renaming the string is safe — but separating the constant from the call, or
removing either, breaks CI rather than silently passing.

## Capabilities

**Each window is granted the plugin, core and app calls its own frontend makes, and nothing
else.** `src-tauri/capabilities/`, one file per window. Every entry is an explicit identifier — no
`core:default`, no `<plugin>:default` — because a default set is how a window came to hold the
whole menu, tray and `image:from_path` API, every store command, `updater:*`, and write access to
the app data directory without a single call site for any of them.

| Window | Granted |
|---|---|
| `main` | event listen/unlisten; the window getters and setters `windowLifecycle.ts` and `windowApi.ts` call, plus `start_dragging`; `log`; autostart enable/disable/is-enabled; `dialog:open`; `fs:read-file` scoped to `$APPDATA/room-map-backgrounds/*`; `opener:open-url` scoped to `https://lumasync.app/*`; `notification:is-permission-granted`; `process:restart` |
| `led-control-popup` | event listen/unlisten; `scale_factor`/`outer_position`/`inner_size` for position persistence; `start_dragging`; `log` |
| `led-twin-overlay-*` | event listen/unlisten; `log` — no window API at all |
| `calibration-overlay-*` | nothing: a static page fed by an initialization script, no IPC |

Some grants have no call site in `src/`, because the caller is a script Tauri or a plugin injects
into every webview. `internal_toggle_maximize` is `data-tauri-drag-region`'s double-click;
`internal_toggle_devtools` is the debug-build devtools shortcut; `notification:is-permission-granted`
is the plugin's `window.Notification` shim, which asks once at load; `opener:open-url` is the
opener plugin's handler for `<a target="_blank">`, which is how the About link opens.

No window holds a store permission: the store plugin is gone, and `shell-state.json` is read and
written only through the shell-state app commands (see
[`contracts-and-state.md`](contracts-and-state.md#shell-state-ownership)). The updater,
notifications and log-directory reveal all run through app commands that call the plugin from
Rust, where the plugin ACL does not apply. `copy_background_image` is checked against the fs
plugin's global scope, which the dialog widens to the picked file — capability scopes play no part
in it.

**App commands are ACL-scoped too.** `build.rs` declares an app manifest (`APP_COMMANDS`), and
with one Tauri admits a `generate_handler!` command only from a window whose capability grants its
`allow-<command>` permission. Without it, the twin overlay could call `pair_hue_bridge` or
`download_and_install_update`. Three guards keep the lists honest:
`verify:shell-contracts` holds `APP_COMMANDS` equal to the handler list;
`verify:window-grants` (`scripts/verify/window-grants.mjs`) walks each window's entry modules,
keeps the exports something live imports, and fails on any command that code can invoke and the
window is not granted, and on any grant no code of that window can reach; and
`capability_policy.rs` resolves every command against every window.

**`src-tauri/permissions/autogenerated/` is committed, not ignored.** tauri-build writes an
`allow-`/`deny-` file per `APP_COMMANDS` entry there on every build, never deletes one
([tauri#14320](https://github.com/tauri-apps/tauri/issues/14320)), and reads every file under
`src-tauri/permissions/` into the app manifest *whether or not* `build.rs` declares one. An ignored
copy therefore survives a switch to a branch without the manifest and turns on command gating that
the branch's capabilities grant nothing for — every app command refused, the updater's startup
check first. Committed, the files leave with the branch. `verify:shell-contracts` holds the
directory to exactly one file per `APP_COMMANDS` entry, so a stale file cannot keep a removed
command grantable. Two checkouts must not share a Cargo target directory either: the `lumasync`
package builds under the same hash in every worktree, and one branch's generated ACL has been seen
inside another branch's binary that way.

| Window | App commands |
|---|---|
| `main` | 51 of the 60: the 50 its `*Api.ts` bridges reach, and `simulate_hue_fault` for the dev mock's panel, which passes it through to Rust from this window. Not the popup's three below, and not the six in the last row |
| `led-control-popup` | `get_shell_state`, `patch_shell_state` (its position, last pattern, hint flag); `apply_outputs`, `retune_lighting`, `get_lighting_runtime` (its mode strip, its Solid drag, the Hue test lease, and `useLightingRuntime`); `start_led_test_pattern`, `stop_led_test_pattern` (`useTestPatternRunner`); `get_led_preview_status` (`usePreviewStatusSync`); `close_led_twin_overlay`, `hide_led_control_popup` (its close button); `show_notification` (the one-time hint); `open_log_dir` (`GlobalErrorBoundary`'s "Show logs") |
| `led-twin-overlay-*` | `get_shell_state` only — it reads the calibration it draws |
| `calibration-overlay-*` | none |
| no window | `request_notification_permission` — registered, but nothing in the frontend calls it. `set_lighting_mode`, `stop_lighting`, `get_lighting_mode_status`, `stop_hue_stream`, `set_hue_solid_color` — the mode commands the lighting transaction replaced ([`lighting-transaction.md`](lighting-transaction.md)). They stay registered and their tests grant them to the test window; a window calling one would skip the transaction's ordering and saving |

`get_led_preview_status`, `close_led_twin_overlay` and `hide_led_control_popup` are the popup's
alone; the main window never calls them. Two withholdings are deliberate even though the walk
reaches them. `replace_shell_state` belongs to the main window: it is the migration write-back,
which the main window runs at boot before any other window exists, and a refused write-back in
another window is logged, not fatal. `patch_shell_state` is not granted to the twin, which only
calls `shellStore.load()`. The overlay and the popup cannot reach pairing, credential migration,
the update check or install, or the migration write-back; `capability_policy.rs` names those
explicitly.

A missing grant fails only at runtime, as a rejected invoke in that one window.
`ipc_tests/capability_policy.rs` resolves the real capability files per window label and asserts
the tables above plus a list of removed grants, and reads through the real fs plugin to check the
scope. A new plugin or core call from the frontend needs its identifier in that window's capability
and a row in the test. A new app command needs an entry in `build.rs`, a grant in each window
whose code calls it, and a row in `APP_POLICY`; the three guards above fail until all of them
agree.

## Gotchas

- **`onboarding` does not include the room map.** The two are separate surfaces despite both being setup-shaped.
- **Native fullscreen draws a second title bar over the custom amber one.** Tauri/tao has an open upstream bug (`tauri-apps/tauri#5115`, `tao#548`) that re-applies the system `NSTitledWindow` styleMask during the fullscreen transition, so a delegate patch loses the race. `macos_window.rs` forbids native fullscreen instead of fighting it: `NSWindowCollectionBehavior::FullScreenNone` removes the fullscreen pathways, and the zoom button is separately disabled so the green dot renders as inert rather than a live control with no effect.
- **Compact mode is not a narrow full mode.** It has its own layout under `settings/sections/compact/`; a component added only to the full layout simply does not exist for compact users.
- **A popover in compact has to be portalled and positioned from a measured height.** `.lm-compact { overflow: hidden }` over `.lm-compact-body { overflow: auto }` clips anything anchored inside the layout, so the colour picker renders through a portal into `document.body` and computes its position from the trigger's rect, refreshed on resize and scroll. Height then has to be *measured*, not estimated: the recent-colours strip mounts lazily and the picker grows after first paint, and at 320×480 the difference is the popover hanging off-screen. A `useLayoutEffect` re-measure follows the first paint and a `ResizeObserver` catches later growth, so the visible position is always the second pass.
- **`RoomMapEditor` is among the largest single pieces of UI in the codebase** — around 800 lines, at the head of a `features/room-map/` tree of roughly fifty more source files — for a surface most users never open. Worth knowing before adding to it. It is a settings *section* that lives in its own feature module, the same way `CalibrationPage` does: `SettingsLayout` is a router, not an owner.
- **Pairing a USB strip adds it as an output target by itself.** Without that, the Lights output toggle stays off until a WebView reload even though the StatusBar USB pill has already flipped to OK — pairing is the intent, so nothing further should be asked of the user. The auto-add is a saved choice like the Lights toggle (`apply_outputs`, `origin: "user"`): Rust saves `lastOutputTargets` and, if a mode is running, starts it on the strip. It used to write the selection directly and leave the start to the next user action, because the frontend's delta path raced its own launch restore; the transaction reconciles to the newest intent, so there is no race to avoid.
- **Bootstrap must not strip `usb` from the output targets when the live snapshot says disconnected.** Cold launch races `tryAutoReconnect`, which waits out the ~2 s bootloader settle before it can report anything; roughly a quarter of starts finish bootstrap first, see `connected: false`, and drop the user's persisted USB target. Auto-reconnect then succeeds and emits `connected: true`, but the hot-plug reconciler's membership check no longer matches, so the output stays silently off until the user toggles it by hand. The target is kept regardless of the snapshot — `modeGuard` already renders the disabled state from `isConnected`, so nothing is hidden from the user. The separate "was USB physically present last time we looked" flag is *not* part of this and must keep tracking the snapshot, or the false→true transition re-fires on every cold start.
- **A structurally unavailable USB port does get dropped from the targets, but only for two codes.** `PORT_UNSUPPORTED` and `PORT_NOT_FOUND` mean the port will not work for the rest of this session — typically a phantom endpoint the allowlist now rejects — and leaving `usb` selected sends every later mode start into the Rust gate, which refuses it with `DEVICE_NOT_CONNECTED`. From the user's seat, Ambilight does nothing. Transient codes (`CONNECT_TIMEOUT`, `CONNECT_IO_ERROR`, `CONNECT_FAILED`) must *not* trigger this: stripping the target on a retryable failure loses a setting the user chose. The surviving set is sent as a saved choice, like the auto-add above.
- **Removing a target from a running mode re-applies the mode on what stays; it never calls `stop_lighting` for one target.** `stop_lighting` is not a USB stop — it turns the whole backend mode Off, so removing USB from `[usb, hue]` that way took the worker feeding Hue with it while the stream stayed open, holding the bridge's one streamer slot and keep-aliving its last frame. The transaction re-applies the mode on the targets that stay (`lighting-transaction.md`, phase 2), which stops the old worker and starts one that never plans the removed output, so an unplugged port is never opened. The Outputs toggle saves the new set; the hot-plug unplug in `useUsbTargetReconciler.ts` sends it with `origin: "usbUnplug"`, which does not: a cable falling out is not the user giving up the strip, and the launch restore keeps `usb` selected while no strip is there.
- **Unplugging the strip that was the only target ends the mode, the way Off does.** `useUsbTargetReconciler.ts` used to act on an unplug only when another target stayed selected, so a USB-only mode — or a `[usb, hue]` restore running on USB alone while it waited for a busy bridge (#441) — got no notice, a worker still capturing for a port that was gone, and the mode still shown running; the busy notice kept saying "running on USB only". Now the reconciler calls the orchestrator's `endLightingOnUsbUnplug`, which sends the empty set with `origin: "usbUnplug"`: session-only (`lastOutputTargets` is never written, nor the persisted mode), the worker stopped whatever the active set says, then Off with the selection kept. The empty set also cancels a pending rejoin the way any output change does, and the left-out reason is cleared with it. The reconciler raises its own notice, `shell:notices.messages.usbDisconnectedLightingOff`, only once the mode has actually ended — with the mode already Off, or a stop that failed (which raises the stop-failed toast instead), there is nothing to report. `normalizeOutputTargets([])` keeps an explicit empty set, which is what lets the delta path see "nothing left".
- **The HUE chip says when Hue is out of the running mode, and says it for longer than the toast.** A bridge that is merely held by another session answers the reachability probe, so while the #441 busy notice said Hue was not running the chip read OK. The runtime snapshot carries the left-out reason (`hueHeldOutReason`), and the main window raises the notice from it: raised and retry-cleared together, but not dismissed by the notice's 8 s timer — the reason holds until Hue joins, or the user makes a mode or output choice. `resolveHueHeldOut` in `statusItems.ts` turns it into WAITING (the busy wait, or the Off-resume wait, amber, no reconnect button) or LEFT OUT (any other reason while a mode runs, with the Devices deep-link). It yields to a live Hue session, so a stop that timed out and left Hue listed active still reads STREAMING beside its stop-failed toast. Every chip value now comes from `shell:statusBar.state.*`; the labels (CAP, USB, WLED, HUE) stay as they are.
- **Removing Hue from a running mode lets the worker go of Hue before the stream stops, and Off stops the worker before Hue whatever the targets.** A stop under a worker still holding its handle on the Hue sender waited out 3 s, reported `HUE_STOP_TIMEOUT_PARTIAL`, and ran the #425 light restore with the sender alive; on the HTTP fallback the next frame painted the restored lights again. The transaction's phase 3 ("Hue down, after the worker has let go") owns this now, and the reasoning is in `hue.md`. Since the worker follows the Hue runtime's live output slot it lets go at its next frame on its own, so the sender's exit no longer depends on this order; the order stays anyway.
- **The Devices Hue card stops Hue through the transaction, never with a bare stream stop.** Stop retrying (reconnecting) and Retry stop (partial stop) used to call `stop_hue_stream` straight from `HueBridgesCategory`, under whatever mode was running — the #445 hole with a different button. They now call `release_hue_output` with the card's trigger source: with the mode Off it is a plain stop; otherwise Hue leaves the running mode first, and a mode that ran on Hue alone ends the way Off does, with the selection kept and nothing saved. It stops Hue even when `hue` is not in the active set or the selection — after a partial stop, or for a stream the card started beside a USB-only mode — and the orchestrator makes it single-flight, so a double press joins the release in flight.
- **A toast's dismissal timer does not belong in the effect that raises it.** The USB-unplug branch in `useUsbTargetReconciler.ts` rewrites `selectedOutputTargets` in the same commit that shows its toast, and that array is a dependency of the effect it lives in. The effect therefore tore itself down and cleared the timeout it had just scheduled, so the toast stayed on screen until something unrelated re-rendered it away. The timer now sits in its own effect keyed on the flag it clears — the shape any auto-dismissing surface should copy.
- **The twin overlay neutralises its background synchronously, before React mounts.** It is created transparent and visible, but `styles.css` paints `--lm-bg` on the body before anything renders, so `main.tsx` clears html/body/#root backgrounds ahead of bootstrap, i18n, and React — otherwise the twin flashes an opaque full-screen frame on open. `LedTwinOverlay`'s own effect repeats the same clear as belt-and-suspenders. Both also reset `color-scheme` to `normal` on the root: the app declares `color-scheme: dark` so native controls render dark, and a dark scheme lets an engine give an unpainted root a dark canvas instead of leaving it clear.
- **The app is dark-only, and says so to the engine rather than to the OS.** `:root` carries `color-scheme: dark`, which is what turns select popups, number spinners, checkboxes and scrollbars dark. A `prefers-color-scheme` branch — or a Tailwind `dark:` variant, which compiles to the same media query — follows the *OS* setting, so on a light-mode machine the body was a light gradient and those variants picked their light half. Neither exists any more, and `stylesheetSanity.test.ts` keeps it that way.
- **The twin overlay gets `TwinErrorBoundary`, not `GlobalErrorBoundary`.** Its fallback renders nothing. The twin is a click-through overlay covering a full display — an opaque fallback card there would blanket the screen with something the user cannot dismiss, so a render throw in the twin must degrade to invisible rather than to a visible error state. The main window and the (opaque) control popup keep the normal amber-card `GlobalErrorBoundaryWithI18n`.
- **Boot restores the persisted UI mode, and the "flash" that once forbade it was never possible.** `restoreWindowState` used to carry a note that writing a persisted full-mode size at boot "would produce a visible big→compact flash before React mounts". The main window is created with `"visible": false` and nothing in Rust shows it, so the only `show()` is the one in `initWindowLifecycle` — after the size and position are applied. There was nothing on screen to flash. Boot now restores position at the created (compact) size, then calls `resizeToMode(mode, { animate: false })` to grow around that centre, reusing the manual-toggle path rather than reimplementing the monitor clamp and full-size memory. Two ordering rules hold it together: `sink.setUIMode` runs *before* `initWindowLifecycle`, or the shell appears full-sized still rendering compact; and `animate: false` must bypass `animateWindowRect` rather than pass it a zero duration, which would make `t` NaN and spin the loop forever.
- **The Windows child-HWND sweep may add `WS_EX_TRANSPARENT` and must never add `WS_EX_LAYERED`.** WebView2's children (`Chrome_WidgetWin_*`, `Chrome_RenderWidgetHostHWND`, `Intermediate D3D Window`, all owned by `msedgewebview2.exe`) do not inherit the parent's ex-style, which is why `propagate_transparent_to_children` exists at all. But a window handed `WS_EX_LAYERED` through `SetWindowLong` "will not become visible until `SetLayeredWindowAttributes` or `UpdateLayeredWindow` has been called for this window" (Win32, *Layered Windows*), and nobody calls either on a window we do not own — so ORing that bit onto the WebView2 subtree makes it paint nothing. The overlay opens blank. `schedule_clickthrough_resweeps` then repeats the marking on a decaying schedule, which turned a race into a certainty rather than causing it. The sweep now sets `WS_EX_TRANSPARENT` alone, checks `SetWindowLongPtrW` against `SetLastError(0)`/`GetLastError` (a cross-process/UIPI refusal must be visible, and the call returns 0 both for failure and for "previous value was 0"), and follows it with `SetWindowPos(SWP_FRAMECHANGED)`, because an ex-style written this way is cached until a frame change is forced. The bits stay idempotent, so a re-sweep that finds an already-marked child is free.
- **Hit-testing is already covered by the top-level, so the child sweep is a belt, not the braces.** `set_ignore_cursor_events(true)` has tao set `WS_EX_TRANSPARENT | WS_EX_LAYERED` on the *outer* window and apply it with `SetWindowPos(SWP_FRAMECHANGED)`; a top-level that is both layered and transparent is skipped by hit-testing entirely, so the mouse never reaches its children in the first place. That top-level demonstrably stays visible with `WS_EX_LAYERED` on it — tao never calls `SetLayeredWindowAttributes` either, and layered+transparent Tauri overlays render on Windows in the field — while a layered *child* is the case the Chromium/CEF "blank child window" reports describe. The CI probe settled the observable half on 2026-08-18: with the bit on the children the whole display goes solid black, without it the overlay draws over the desktop, and hit-testing falls through in both cases — so the bit was the whole blank-overlay fault and never bought any click-through. Why a layered top-level renders and a layered child does not is still a reading (DWM composition carrying the former), not a measurement. `LUMASYNC_WIN_OVERLAY_SWEEP` exists to settle which half is actually load-bearing on real hardware: `off` (no child touched), `transparent` (default), `transparent+layered` (reproduces the ≤1.5.5 behaviour). It is read once per process through a `OnceLock` and governs the initial sweep and every re-sweep alike.
- **A transparent overlay must not set `background_color`.** `WebviewWindowBuilder::background_color` writes both layers, and on Windows the *window* layer drops the alpha channel: tao stores the RGB and answers `WM_ERASEBKGND` with `CreateSolidBrush` + `FillRect`, so `Color(0, 0, 0, 0)` erases the client area to opaque black. The webview layer ignores the value anyway — wry forces `(0, 0, 0, 0)` whenever `transparent` is set — so the call could only ever hurt. `focusable(false)` is set instead, which is `WS_EX_NOACTIVATE` on Windows and `canBecomeKeyWindow: NO` on macOS; a click-through overlay has nothing to type into and must never take activation.
- **The `OverlayState` lock must not span `build()`.** `open_display_overlay` reads the previous label and computes the next one under the lock, releases it, does the window work, then re-locks to commit — hence the split between `run_overlay_open_transition` (sequencing, pure) and `apply_overlay_open_transition` (bookkeeping, pure). Holding the guard across `WebviewWindowBuilder::build()` deadlocks the main thread on Windows: wry/webview2-com runs a nested message pump inside `build()` (`wait_with_pump`), which dispatches queued tray-menu and IPC messages re-entrantly, and `std::sync::Mutex` is not reentrant. The tray's Close Overlays rescue cannot recover from that, because it needs the same main thread.
- **Windows overlay behaviour is unverifiable anywhere but Windows.** Nothing in CI or on the other two platforms enters these code paths, and the Rust cross-check dies in `aws-lc-sys` on macOS, so the first compile of a change here is the `windows-latest` CI job. The bench recipe, in order: **T0** — an external HWND probe over the overlay's tree, dumping the ex-style in hex plus `GetLayeredWindowAttributes` for the top-level and every child, and `WindowFromPoint` over the overlay area. **T2** — three runs with `LUMASYNC_WIN_OVERLAY_SWEEP` set to `off`, `transparent`, `transparent+layered`, comparing whether the overlay paints and whether clicks reach the desktop underneath. **T3** — the calibration overlay (which leaves the shell on screen) against the LED preview (which hides it), since only the second can look like "the app disappeared". **T4** — while wedged, does the tray menu open at all? If it does not, the main thread is blocked and the fault is the lock, not input routing. T0 and T2 no longer need a human: the `windows-latest` CI job runs them and gates on the result, keeping the `overlay-smoke-windows` artefact — see [`build-and-release.md`](build-and-release.md#the-windows-overlay-probe).
- **The tray's Close Overlays item is a backend-only rescue, and that is the point.** The overlays are `closable(false)`, `skip_taskbar(true)` and undecorated, so one that captures input rather than passing it through leaves no title bar, no taskbar button, and nothing clickable underneath. Every other tray item emits an event and lets the frontend act; `close_all_overlays` instead destroys the windows from Rust and shows the main window unconditionally — not through `restore_main_after_preview`, which by design only acts when the preview is what hid it. Depending on a round trip through the webview is exactly the assumption a wedge invalidates.
- **Only a user-driven resize records the window size, and it records the *inner* rect.** `persistWindowState` saved nothing but the centre, and `lastFullSize` was written in exactly one place — `resizeToMode`, when *leaving* full. So dragging the window edge was never persisted: a reload restored the size from the last compact↔full toggle and the window snapped back. The debounced `onResized` path now captures it, but `resizeToMode` passes `captureSize: false`, because at boot it runs while the window is still at its created compact size and capturing there wrote 320×452 over the size it was in the middle of restoring — the existing "re-entering full does not overwrite the remembered full size" case catches exactly that, and did. The stored value is logical **inner** px to match what `resizeToMode` reads back; persisting the outer rect would restore a window one title bar taller each cycle. Compact is deliberately not recorded — it is a fixed tray popup, and `UI_MODE_SIZES.compact` stays its size.
- **A target window size is clamped down to the work area, and never up.** `ensureWindowRectOnScreen` only ever moved a rect — width and height passed through untouched — so the 900×620 full default, and any `lastFullSize` remembered from a bigger display, were applied to whatever screen the window happened to be on. Too tall and the bottom edge is off-screen with the resize grip on it, so nothing the user can do brings it back. `fitSizeToWorkArea` shrinks the target in `resizeToMode`, and the same clamp applies to `setMinSize`: a floor larger than the screen is worse than none, since the OS then refuses every resize that would fit. It reads `Monitor.workArea`, not `Monitor.size`, so a tall taskbar counts — and falls back to full bounds when a platform reports no work area, because a missing dock inset must not silently turn the clamp into a no-op. A remembered size is never grown: since #286 the full size the user chose wins. The one exception is a genuine first run, with no remembered full size, where 900×620 is scaled uniformly toward 62% of the work area of the window's own monitor, floored at 900×620 and capped at 1.6× (1440×992) before the same shrink clamp — a fixed default is a postage stamp on a large display, and there is nothing the user chose to respect yet. Note the position clamp still uses full monitor bounds; `WINDOW_EDGE_MARGIN = 0` is deliberate there and left alone.
- **The App content slot is a flex column, and an in-flow banner above a `height: 100%` layout is why.** The notice slot (once the onboarding banner) and `SettingsLayout` are siblings inside the `absolute inset-0` slot, and both compact (`.lm-compact { height: 100% }`) and full (`h-full`) size themselves to the whole slot. As a plain block column the banner therefore pushed the layout down by its own height and the backdrop's `overflow-hidden` clipped exactly that much off the bottom — above the layout's own scroll container, so the lost strip was unreachable rather than scrollable. Measured in Chromium at 320×480: a 162 px banner took the entire compact scene row 78 px past the visible edge; full mode lost 58–73 px. The column plus a `min-h-0 flex-1` box around the layout makes the two share the height instead. The banner's own `flex-shrink: 0` is part of it — without it the banner gives up height rather than letting the layout scroll. Separately, the banner wraps its actions onto a second row below 480 px: unwrapped it is 132–162 px against the `< 80 px` this surface is documented to cost, and only compact ever reaches that width since full floors at 800. None of this is assertable in `happy-dom`, which has no layout engine, so `App.notices.test.tsx` guards the structure and this entry carries the numbers.
- **The onboarding banner shows only a step whose guard has settled.** A user upgrading from a build without `hasCompletedOnboarding` has the flag read as `false` early in bootstrap, while the guards that would complete the flow arrive later — the persisted ones after bootstrap's serial-status await, the live ones (a remembered strip reconnecting, a paired bridge's first probe) later still. The banner used to mount at step 1 and vanish a moment later. `useOnboardingStep` now waits for `guardsLoaded` (App passes `bootstrapDone`) before showing anything, shows the lights and LED-setup steps at once because their guards are persisted, and holds the devices step back 3 s — 8 s while a bridge probe is still out (`onboardingRevealDelayMs`). A fresh install reaches step 1 as soon as bootstrap finishes. Once shown, the banner stays until it completes or is dismissed. The cost is that a set-up user whose strip takes longer than 3 s to reconnect still sees step 2 briefly.
- **Every shell notice goes through one queue and one slot.** Nine toasts used to sit at fixed bottom offsets of `3.5rem` each while their real heights were 74–90 px, so they overlapped — the permission toast's only button among the covered — and several shared a slot outright; they were z-50 like `UpdateModal` and later in the DOM, so they drew over it outside its focus trap; and in compact the onboarding and offline banners together took over half of the 422 px body and arrived seconds apart, pushing the mode strip down ~200 px under the pointer. Now `buildShellNotices` (pure) turns every source into a `ShellNotice` — severity, `condition` or `event`, one action plus an optional second one, a stable id — and `orderNotices` sorts them by tier: error conditions (permission denied, capture stalled, no output, the calibration lock), error events (start, stop, preview-open failures), warnings (Hue left out or waiting, USB unplug and unsupported, Hue colour), then info (checking outputs, onboarding, and last a failed startup update check). `useShellNoticeQueue` adds only what a source's timer cannot know; `ShellNoticeSlot` shows the top notice and a "+N" that expands the rest in place. Both modes put the slot in flow above the content, flush to its edges, so it pushes the controls and never covers them. Each notice is one 32 px strip line — a severity dot, one sentence, a text-link action, then × and the "+N" — with the text inset to the content below (12 px in compact, 22 px in full). The line was a rounded card with a left accent bar, a glyph, a title over a body and outlined buttons, 44–48 px each; the card read as decoration and the title and body said the same thing twice, so every notice is now a single sentence that leads with what happened. The action's 32 px hit area is the row's full height, not a box drawn round the label. A sentence that does not fit ends in an ellipsis: the native tooltip carries the rest, and because a tooltip needs a pointer, a cut line also gets its own toggle that wraps it. Whether the line is cut is measured (`scrollWidth` against `clientWidth`, re-measured on resize) and only while it is unwrapped, so the toggle that wrapped it stays to fold it back. Expanded, every line wraps. The dot differs in shape as well as colour — disc, diamond, ring for error, warning, info — so severity survives forced colours; the spoken label before the sentence carries it for a screen reader.
  - *Conditions clear by state, events by their source's timer.* The queue has no clock for either. What it adds for events: pointer or focus inside the slot holds any event whose source let go (released 1.5 s after it leaves), and an event raised while the update prompt was open waits under it and gets 4 s once the prompt closes. A × hides one occurrence, not the id — a source raising a new value, or the same one again after it cleared, is shown again. Retention is decided during render, not in an effect, or the card under a keyboard user's focus would unmount for a frame and drop it. The queue keys on the notices' content rather than the array, because callers rebuild the list on renders where nothing changed and the render-phase retention would otherwise never settle.
  - *Screen-recording permission is a condition.* It was an 8 s toast for a state that lasts until the user acts, so the explanation and the only button vanished while nothing had changed. The orchestrator no longer times a `permission`-bucket start failure out; it clears when a later mode apply succeeds (including the start the advisory probe ran ahead of — the probe cannot tell "denied" from "never asked") or when `useCapturePermissionRecheck` sees the non-prompting probe answer GRANTED, which it asks every 3 s while the window is visible and at once when the window regains focus. Only GRANTED clears it: the probe reads a failed call as NOT_REQUIRED.
  - *Duplicates are dropped, not stacked.* Onboarding step 2 is hidden while the no-output notice says the same thing, and step 3 while the calibration notice does; step 3 also shows only when a strip or WLED panel is bound, since a Hue-only setup has no LEDs to calibrate and every fresh install starts with `usb` selected; the calibration notice waits while there is no output at all; and step 1 offers no "Open lights" where the user already is.
  - *No output, checking and calibration follow the Lights mode buttons.* They explain why those buttons are dim, so they show where the buttons are: always in compact, and on the Lights section in full. Full mode used to draw its own copies inline on the Lights page (`OnboardingBanner`, `OutputCheckingNote`), in a second visual language, beside the queue's card for the same state. Only the queue says them now, and the page just disables what they cover. The full banner's two buttons survive as the notice's `action` and `secondaryAction`: once the bridge probe has given up, "Check again" leads and "Open devices" sits beside it. The second action shows on the full line and in an expanded compact strip, never on the compact line, which has room for one.
  - *Full mode puts the slot on top, not bottom right.* It was a bottom-right stack while it held only events. Once it held conditions that can last a whole session, a floating card there covered the bottom right of the page at every scroll position, the end of the Lights column included, and put "no reachable output" about 400 px away from the dim mode buttons it explains. In flow at the top it sits directly above those buttons and covers nothing. The cost is that an event (a USB unplug) moves the page down by one card while it is up, as it already did in compact; only one card is ever in flow unless the user expands "+N".
  - *One live region.* `ShellNoticeAnnouncer` is mounted once, outside the slot, and speaks each occurrence once, when it first reaches the top — never while the prompt is open. Cards carry no `aria-live`, and the StatusBar is no longer one: its FPS pill changed every second.
  - *Under the update prompt.* The slot renders before `UpdateModal` in the DOM, at z-index 45 against the prompt's 50, and is `inert` while the prompt shows. The prompt itself fits 320×480: its body scrolls and its actions stay pinned, and the card keeps clear of the StatusBar while the scrim still covers it.
  - *A background update check never takes the screen.* The startup check fails on every offline boot, and one that failed at the invoke layer on a broken build opened the blocking prompt labelled as a failed installation. Now `useAutoUpdater` separates the automatic check from one the user started. An automatic failure is logged with `[LumaSync]` and raised as an info event (`update-check-failed`), listed last so it never pushes an onboarding step out of view, and gets an 8 s timer that counts only while the window is visible, since the check usually finishes with the window still in the tray. Its "Try again" is a user check: the notice stays up with the button pending and no countdown while the check runs, and leaves when it answers — through the prompt if it failed again or found an update. The prompt's error wording follows the failed step (`phase: "check" | "install"`) rather than the code, because an invoke rejection carries none.
  - *Space is held, not jumped.* Checking outputs occupies the slot from the first frame, and "no output" or onboarding replaces it in place. While boot or an onboarding reveal is still pending, a slot that has shown something keeps its 32 px even when empty, so the strip does not rise and fall again. The cost is a brief empty band on a set-up machine whose checking notice clears before a pending reveal resolves to nothing.
  - *Actions only where a destination exists.* Hue auth, unreachable and not-set-up open the Hue category in Devices (`DeviceSection`'s `categoryRequest`, a nonce so asking twice counts); a vanished display opens LED setup, as the copy says; a failed Hue stop retries through `stopHueOutput`, never `stopHue`. A strip that would not stop has no button — the copy says to switch the mode Off instead — rather than a retry that could not reach it.
- **Frontend console output is bridged into the Rust log sink.** `src/main.tsx` wraps `console.log/info/warn/error` and forwards them into `tauri-plugin-log`, so frontend lines land in the same file as `log::info!`. Plugin-log records with a caller use targets shaped like `webview::<location>` (2.9.2 onward; earlier releases wrote `webview:<location>`, which fern's `level_for` inheritance — it only walks Rust's `::` separator — never matched). The debug logger keeps `Info` as its global floor, which covers frontend records under either shape, so do not reintroduce a `level_for("webview", ..)` as the only thing letting them through. A rejected bridge call is reported once through the original console.
