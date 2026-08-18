# Screen capture and the frame pipeline

From a captured frame to bytes on a wire. This is the only hot path in the application: everything
here runs per frame, and a regression in it is a defect rather than a tuning matter.

Implementation in `src-tauri/src/commands/ambilight_capture.rs` and `lighting_mode.rs`.

## Decisions

**Capture is per-platform and native.** ScreenCaptureKit on macOS, Windows Graphics Capture on
Windows, X11 on Linux. Wayland is not supported and needs `xdg-desktop-portal` before it can be.
**No release is named for it in committed source**, deliberately: the code comment and this file
used to promise different versions, so neither promises one now. `xcap` already falls through to
PipeWire on a Wayland session, which is why it sometimes appears to work — that path is untested and
unsupported, not a soft launch.

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

**Smoothing is an EWMA per light; the preset is a ceiling on it.** `LightingSmoothingPreset` in
`src/shared/contracts/lighting.ts` maps three names to three alpha values. They used to be applied
as-is; since the scene-adaptive stage below they are the *most* movement a frame may use, and the
stage picks the value each frame. `HueIntensityPreset` is a deprecated alias kept so pre-v1.4 call
sites compile.

### Scene-adaptive stage

`src-tauri/src/commands/ambilight_scene.rs`. One sink-agnostic step between the region samplers and
the per-sink smoothers, driven by the maintainer's side-by-side against Hue Sync: sampling every
light on its own reads as many independent samples rather than one lit room, while a fixed
smoothing constant is either too sluggish on a cut or too jittery on a still shot. Every reference
implementation we read (Hyperion.ng, Prismatik, Luciferin) has exactly two positions — every light
independent, or every light identical — and the middle ground had to be built. The stage does four
things, in this order, per frame:

1. **One subsampled pass over the frame** (stride 8, inside the black-border insets) yields the
   frame mean and a 64-bin colour histogram. The histogram's L1 distance to the previous frame's is
   the *change* signal — the classical shot-boundary measure, chosen because the edge-based
   alternatives cost far more for no better hit rate.
2. **Coherence** is an edge-preserving (bilateral) filter over the *chain of lights* — neighbours by
   strip order for a USB strip, by position for a Hue set. Two lights blend in proportion to how
   close they are *and* how similar their colours are, so a uniform sky wraps around a corner but a
   sky-over-grass boundary stays a step. "Similar" is measured in Y and CIE u′v′ — the unit CIE
   specifies for light-source chromaticity difference; ΔE00 needs a white reference and RGB
   distance changes meaning with hue — and the scale of "similar" is set **per frame** from the
   median difference between adjacent lights: only what is unusual *in this frame* survives as an
   edge. Chroma is related over a wider neighbourhood than luminance, because chromatic contrast
   sensitivity is low-pass and luminance sensitivity is not — smoothing hue across neighbours is
   nearly free perceptually, smoothing brightness the same way flattens visible structure.
3. **Ambience blend.** The stage keeps a slow memory of the frame mean (the room's ambience colour)
   and mixes a little of it into every light. How much depends on two things: *what the frame is*
   (a flat frame leans more, since nothing is lost; a structured one keeps its region colours) and
   *where the light is* — `screen_affinity`, `1.0` for a strip LED on the screen edge and lower for
   a Hue channel placed away from the TV wall. A bulb behind the viewer therefore shows mostly the
   room's colour with a hint of its side of the screen, instead of a hard sample of the bottom of
   the frame; that is the "defensible colour for a light with no screen region" the product bar
   asks for. Today affinity for Hue comes from the bridge's own `y`; the room map will supply a
   metre-based value through the same per-light `f32` when placement drives the runtime.
4. **Alpha as a continuous function of change.** The change signal is run through an envelope with
   instant attack and slow release; alpha is interpolated between a floor (30 % of the preset) and
   the preset ceiling by that envelope. A hard cut lifts every sink to the ceiling for a few frames
   and the lights follow decisively; a still or slowly drifting scene sits at the floor and steers
   gently. There is deliberately **no cut detector and no state reset** — nothing is declared, the
   filter simply moves as fast as the content did, so a pan or an explosion raises alpha for a
   moment without ever producing a discontinuity. Both the USB `RuntimeQualityController` and the
   Hue `HueChannelSmoother` read the same alpha.

Cost, measured with the `#[ignore]`d `cost_on_a_full_frame` test on a 640×360 frame and 200 LEDs:
about 22 µs per frame in release, ~160 µs in debug — three orders of magnitude under the frame
budget. Every threshold in the module is a tuning constant expressed in u′v′ / Y, not a derived
one; no published number exists for how far apart two adjacent lights may be before a wall stops
reading as one surface, and the module header says so.

Two things stay outside the stage: **synthetic test frames** bypass it (a test pattern must reach
the strip exactly as painted), and **`LUMASYNC_AMBILIGHT_LEGACY=1`** in the environment at worker
start bypasses it for a live session — a development A/B switch for bisecting a report, not a
setting, and it is read once when the worker starts.

## Gotchas

- **`AMBILIGHT_CAPTURE_PERMISSION_DENIED` means the macOS Screen Recording permission is missing**, not that capture is broken. It needs a user trip to System Settings, and the app cannot grant it. It is now only produced after a real preflight; a ScreenCaptureKit failure *with* permission granted is `AMBILIGHT_CAPTURE_SHAREABLE_CONTENT_FAILED` instead, usually a wedged `replayd`.
- **`list_displays` needs no permission, so a denied user still sees a full display picker.** It reads Tauri's `available_monitors()`, not ScreenCaptureKit. The picker being populated proves nothing about whether capture will produce frames.
- **Worker lifecycle is traceable in the log and should be read before guessing.** `[apply_mode_change]` for mode activation, `[ambilight-worker]` for the capture worker, `[stop-worker]` and `[stop_previous]` for teardown.
- **A frontend payload arriving without an LED count falls back to the persisted value.** The line `led_calibration fallback engaged — payload_total_leds=0` means the frontend sent nothing usable and the backend read `shell-state.json` instead. The fallback is deliberate — an invalid external input gets an explicit fallback, never a silent default — but it firing on every startup would mean something upstream is wrong.
- **Windows' capture-control `Drop` detaches its stop onto its own thread.** `CaptureControl::stop()` both signals and joins the WGC message-loop thread, an indeterminate wait. That `Drop` runs on the Tauri command thread during a mode switch, so calling `stop()` inline would freeze the caller — falsifying the non-blocking contract the macOS sibling (`MacOSLiveFrameSource`) already honours. No grace-period sleep is needed the way macOS needs 150 ms: that sleep guards a DispatchQueue ref-count race specific to `SCStream`, which `windows-capture` has no equivalent of.
- **A capture failure *after* a successful start can only travel through telemetry.** The command already returned `AMBILIGHT_MODE_STARTED`, so no status code is left to carry it. `RuntimeTelemetrySnapshot.last_capture_error_code` holds the reason, sticky for the worker's lifetime, and `last_capture_error_at_secs` is what separates "failing now" from "failed once and recovered" — read them together or a display unplugged an hour ago looks identical to one unplugged a second ago. The failure branch of the worker loop carries its own `flush_if_due` for exactly this reason: the success branch owns the only other flush, so without it a sustained outage would freeze telemetry at the last good frame.
- **The fast-path guard is a list of everything read at worker construction, and adding a field to `LightingModeConfig` means adding it there too.** `apply_mode_change` retunes a running ambilight worker in place — cheap, and the only way a brightness drag is not a worker restart per commit. It can only do that for values the worker reads *live*, from `AmbilightLiveSettings` atomics. `led_calibration`, `color_correction`, `firmware_profile` and `chip_type` are read once, when the encoder and sink are built, so each has to break fast-path equality or the change is silently swallowed: the command returns `AMBILIGHT_MODE_UPDATED`, the UI shows the new setting, and the strip keeps being driven the old way. `chip_type` shipped missing from that list, so selecting SK6812 RGBW left the encoder emitting three bytes per pixel. A frontend-side `force` flag does not help — it only bypasses the frontend's own signature dedupe so the invoke happens at all.
- **A running test pattern retunes in place; only its geometry forces a rebuild.** `SyntheticFrameSource` re-reads its pattern and speed from a shared `TestPatternLive` cell every frame, the same way `pattern_phase` already survives a rebuild — so `apply_mode_change` treats a test-to-test change as a fast-path update and writes the cell instead of tearing the worker down. Everything else the source bakes in at construction — the frame size (from `display_aspect`) and the LED sequence — still restarts it, and so does live→test or test→live, because the frame source itself has to change. Before this, every commit of a colour drag was one full worker teardown, which is the only reason the frontend throttle existed; lowering that throttle without the cell would have multiplied rebuilds rather than smoothing anything.
- **Revealing the control popup hides the main shell, and only the preview that hid it may bring it back.** The preview owns the screen while it runs, so `show_led_control_popup` hides `main` — but it records whether it actually hid anything, because the tray opens the preview with the shell already away and closing it must not conjure a window the user never had. `hide_led_control_popup` and the popup's red-X path in `lib.rs` both restore, so the flag is read-and-cleared in one step: whichever gets there second must be inert, or it would raise a window the user had since put away. Note that hiding `main` fires `visibilitychange`, which pauses the Hue polling loops and telemetry until it is shown again — harmless during a test, and worth knowing before reading a gap in the logs as a fault.
- **The worker join happens under the runtime lock on purpose, and moving it out would trade a stall for a crash.** `stop_previous` calls `LightingWorkerRuntime::stop` while the caller still holds `LightingRuntimeState::runtime`, so a ~100–300 ms join delays anything else wanting that lock. That reads like an oversight and is not one. `stop()` takes `self` **by value**, and the ordering is the point: signal `cancel`, join the worker thread so it drops its `Arc` clone, and only then let `self` drop — which releases the last `_frame_source` reference **on the command thread**. That is what keeps `SCStream::stop_capture` off the worker thread, and off it is the difference between a clean teardown and a macOS crash on rapid mode switches. Releasing the lock between stop and start would also let a new `SCStream` be created while the old one is still tearing down — the exact rapid stop/recreate cycle `AmbilightLiveSettings` exists to avoid. The contention is small in practice: the other holders of that lock are `stop_lighting`, `get_lighting_mode_status` and `preview_snapshot`, all status reads, and runtime telemetry polls a different lock entirely. **Do not "fix" this without first moving the frame-source drop somewhere provably safe.**
- **The per-frame budget is shared with whatever else runs per frame.** Anything added to this path competes with capture, colour work, and the send itself. Measure against the existing runtime telemetry before shipping, not after.
