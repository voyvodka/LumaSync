# Screen capture and the frame pipeline

From a captured frame to bytes on a wire. This is the only hot path in the application: everything
here runs per frame, and a regression in it is a defect rather than a tuning matter.

Implementation in `src-tauri/src/commands/ambilight_capture.rs` and `lighting_mode.rs`.

## Decisions

**Capture is per-platform and native.** ScreenCaptureKit on macOS, Windows Graphics Capture on
Windows, X11 on Linux. Wayland is not supported and needs `xdg-desktop-portal` before it can be.

**Frames are downscaled before analysis on all three platforms.** `MAX_CAPTURE_DIM` in
`ambilight_capture.rs` caps the working dimension at 640. Full-resolution analysis buys nothing for
an output that is at most a few hundred LEDs, and it is the difference between comfortable and
impossible inside the frame budget.

Only macOS gets it for free: ScreenCaptureKit is asked for the smaller frame, so the reduction
happens on the GPU before the buffer is handed over. Windows and Linux both receive a whole native
frame — `windows-capture` 2.0 and `xcap` 0.9 each expose no equivalent of the `output_size` hint —
and reduce it CPU-side through the shared `downscale_stride` / `subsample_rgb` pair. That is a
nearest-neighbour scaffold, not the design, and keeping one implementation for both is what stops
the two paths drifting apart.

The stride is `longest_edge / 640` clamped to 1, so the cap is approximate rather than exact: a
1280-wide display strides by 2 down to 640, but a 1279-wide one strides by 1 and passes through
whole. Displays under 640 are a true no-op.

**`macos-private-api` is enabled**, for fullscreen calibration overlays across all displays. It is
two private KVC keys (`drawsBackground`, `fullScreenEnabled`), not linked private symbols.

**One capture worker drives every configured output at once.** Hue, serial, and WLED are fed from
the same frame rather than each running its own capture.

**The macOS screen-recording permission is probed, never inferred.**
`src-tauri/src/commands/screen_capture_permission.rs` owns two CoreGraphics calls with very
different side effects, and the split between them is the whole design:

- `CGPreflightScreenCaptureAccess` is a pure query. It never prompts, is safe to call repeatedly,
  and cannot distinguish "denied" from "never asked" — which is why the copy says *check this
  permission*, never *you denied it*.
- `CGRequestScreenCaptureAccess` prompts when the decision is undetermined, and the system shows
  that prompt **once per binary, for the life of the install**. Denied thereafter, it returns
  false without prompting.

So `get_screen_capture_permission` (the command the UI calls before enabling Ambilight) preflights
only, and `select_display` on the capture start path is the *single* caller allowed to request. A
UI that gated the start on the preflight answer would short-circuit before the request ever ran,
and a first-run user would never be asked at all. That ordering is load-bearing, not stylistic.

**Smoothing is an EWMA per light, selected by preset.** `LightingSmoothingPreset` in
`src/shared/contracts/lighting.ts` maps three names to three fixed alpha values, applied uniformly
to every sink. `HueIntensityPreset` is a deprecated alias kept so pre-v1.4 call sites compile.

## Gotchas

- **`AMBILIGHT_CAPTURE_PERMISSION_DENIED` means the macOS Screen Recording permission is missing**, not that capture is broken. It needs a user trip to System Settings, and the app cannot grant it. It is now only produced after a real preflight; a ScreenCaptureKit failure *with* permission granted is `AMBILIGHT_CAPTURE_SHAREABLE_CONTENT_FAILED` instead, usually a wedged `replayd`.
- **`list_displays` needs no permission, so a denied user still sees a full display picker.** It reads Tauri's `available_monitors()`, not ScreenCaptureKit. The picker being populated proves nothing about whether capture will produce frames.
- **Worker lifecycle is traceable in the log and should be read before guessing.** `[apply_mode_change]` for mode activation, `[ambilight-worker]` for the capture worker, `[stop-worker]` and `[stop_previous]` for teardown.
- **A frontend payload arriving without an LED count falls back to the persisted value.** The line `led_calibration fallback engaged — payload_total_leds=0` means the frontend sent nothing usable and the backend read `shell-state.json` instead. The fallback is deliberate — an invalid external input gets an explicit fallback, never a silent default — but it firing on every startup would mean something upstream is wrong.
- **Windows' capture-control `Drop` detaches its stop onto its own thread.** `CaptureControl::stop()` both signals and joins the WGC message-loop thread, an indeterminate wait. That `Drop` runs on the Tauri command thread during a mode switch, so calling `stop()` inline would freeze the caller — falsifying the non-blocking contract the macOS sibling (`MacOSLiveFrameSource`) already honours. No grace-period sleep is needed the way macOS needs 150 ms: that sleep guards a DispatchQueue ref-count race specific to `SCStream`, which `windows-capture` has no equivalent of.
- **A capture failure *after* a successful start can only travel through telemetry.** The command already returned `AMBILIGHT_MODE_STARTED`, so no status code is left to carry it. `RuntimeTelemetrySnapshot.last_capture_error_code` holds the reason, sticky for the worker's lifetime, and `last_capture_error_at_secs` is what separates "failing now" from "failed once and recovered" — read them together or a display unplugged an hour ago looks identical to one unplugged a second ago. The failure branch of the worker loop carries its own `flush_if_due` for exactly this reason: the success branch owns the only other flush, so without it a sustained outage would freeze telemetry at the last good frame.
- **A running test pattern retunes in place; only its geometry forces a rebuild.** `SyntheticFrameSource` re-reads its pattern and speed from a shared `TestPatternLive` cell every frame, the same way `pattern_phase` already survives a rebuild — so `apply_mode_change` treats a test-to-test change as a fast-path update and writes the cell instead of tearing the worker down. Everything else the source bakes in at construction — the frame size (from `display_aspect`) and the LED sequence — still restarts it, and so does live→test or test→live, because the frame source itself has to change. Before this, every commit of a colour drag was one full worker teardown, which is the only reason the frontend throttle existed; lowering that throttle without the cell would have multiplied rebuilds rather than smoothing anything.
- **The per-frame budget is shared with whatever else runs per frame.** Anything added to this path competes with capture, colour work, and the send itself. Measure against the existing runtime telemetry before shipping, not after.
