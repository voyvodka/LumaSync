# Screen capture and the frame pipeline

From a captured frame to bytes on a wire. This is the only hot path in the application: everything
here runs per frame, and a regression in it is a defect rather than a tuning matter.

Implementation in `src-tauri/src/commands/ambilight_capture.rs` and `lighting_mode.rs`; the worker
thread itself is `lighting_mode/worker.rs`.

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

**Every sampler crops the same black borders.** `BlackBorderCache` re-detects letterbox and
pillarbox bars at most every 2.5 s, and the strip, the scene stage and Hue all sample inside those
insets: `sample_frame_within_insets` maps each LED onto the picture rectangle and keeps its window
out of the bars, so on a 2.39:1 film the top and bottom LEDs take the picture's edge instead of
black. `AmbilightFramePipeline::sample_strip` is where the cache is refreshed, because it is the
first thing the pipeline sees of a frame; the three consumers therefore read one answer per frame.
From the per-LED sampler in 1.4.0 until this was fixed the strip sampled the whole frame while Hue
was cropped. Three edges are deliberate:

- The setting is read after capture, so switching detection off reaches the strip one frame after
  Hue and the scene stage.
- The worker's warm-up frame is sampled before the pipeline exists and is never cropped; the
  strip's smoother fades away from it over roughly the first second.
- A synthetic test frame is mostly black and the detector would crop it. Test patterns stay exact
  only because `start_led_test_pattern` builds its payload from `AmbilightPayload::default()`,
  which leaves detection off.

**Strip geometry is one answer, pinned on both sides.** Where each LED sits in strip order
(`build_led_sequence` / `buildLedSequence`) and where it samples (`led_to_screen_pos` /
`ledScreenPosition`) are held to one fixture,
`src/features/preview/__tests__/ledScreenGeometry.golden.json`, read by `cargo test` through
`include_str!` and by vitest. Rust is the authority — it decides what the LEDs show — and the
fixture is regenerated from it by the ignored `write_led_screen_geometry_golden` test. The twin
overlay draws each dot at its LED's sampling position, pulled in from the viewport edge. Two
consequences are the sampler's, not the twin's: `bottomMissing` does not move bottom LEDs (they
spread across the whole bottom edge, while the calibration editor draws the physical gap), and a
one-LED edge samples its local-0 corner.

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
   asks for. Without a TV anchor, affinity for Hue comes from the bridge's own `y`; with one, the room
   map supplies a metre-based value through the same per-light `f32` (`room-map.md`).
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

### Measuring the frame budget

Everything the worker computes per frame after capture is one type, `AmbilightFramePipeline` in
`src-tauri/src/commands/lighting_mode/frame_pipeline.rs`: the black-border cache, strip sampling,
the scene stage, strip smoothing, and the Hue path (room-aware sample points, colour correction,
smoothing). The worker keeps only the I/O around it — capture, the sends, telemetry, the twin
feed. That split is what lets the real code be measured with no display and no hardware, from
`lighting_mode/frame_pipeline_tests.rs`.

**Timing, locally.** An `#[ignore]`d report runs the pipeline plus the serial encoder over synthetic
640×360 and 640×400 frames — what ScreenCaptureKit hands the worker after its GPU downscale — for
164 LEDs and for 300, each with two room-aware Hue channels, and prints median / p95 / mean per
stage:

```bash
cd src-tauri
cargo test --release --lib frame_budget_report -- --ignored --nocapture
```

Quote release numbers: the whole step was ~40 µs (164 LEDs) and ~74 µs (300 LEDs) when this
landed, under 0.5 % of a 60 Hz frame. Debug runs about 16× slower overall and up to 50× on the
encoders, so it only compares two builds of the same profile. A release build (test or
`tauri build`) failing with `can't find crate for ctor_proc_macro` on macOS 27 is an old toolchain:
rustc 1.94 strips proc-macro dylibs in a way macOS 27's dyld rejects ("mis-aligned LINKEDIT string
pool"); rustc 1.98.1 builds cleanly, so run `rustup update`. `CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_STRIP=none`
also works around it.
It is a plain test, not `criterion`: the
pipeline's types are crate-private, which a `benches/` target cannot reach without a public facade
over the hot path, and criterion adds 16–19 crates to the lockfile for a report CI never runs.

**The CI guard counts instead of timing**, because wall-clock time on a shared runner is noise.
`steady_frame_allocations_and_lut_builds_stay_within_budget` runs in the ordinary `cargo test`. The
test binary installs a counting global allocator — it counts only on a thread that asks — and for
every steady-state frame through the pipeline and `SerialSink::send_frame`, over the production
serial writer with a counting port behind it, asserts:

- **at most three heap allocations** — the sampled strip, the smoothed strip queued for the sink,
  the encoded packet — and no more bytes than those three need. A copy of the frame, a rebuilt Hue
  sample table, a `collect()` on the Hue path or a cloned port name each fails it. Handing the
  packet to the writer is a copy into a buffer it gives back, not an allocation.
- **none on the writer thread.** The port counts from inside `write`, on the writer thread, what
  that thread allocated since its previous write.
- **no gamma or sRGB LUT tabulation.** Both tables live on the stack, so the allocator cannot see a
  rebuild; the thread-local build counters in `led_output.rs` and `ambilight_scene.rs` can.

`CorrectedWledSink` has its own pin, `WLED_ALLOCS_PER_FRAME` (four: the corrected strip, the
datagram list, the chunk list, one datagram), over a loopback socket nothing reads.

A change that genuinely needs another per-frame allocation raises `ALLOCS_PER_FRAME` in the same
PR and says why. The worker's check of the Hue output slot (`hue.md`, "The worker follows the live
stream") is one relaxed atomic load per frame; it locks and clones only on the frame after a Hue
start, reconnect, restart or stop. Outside the guard: the Hue send's `to_vec()` (the sender thread takes an owned
`Vec`), the twin-overlay feed (`the_edge_signal_is_built_and_sent_only_while_a_twin_is_open`), and
capture itself.

**Equivalence.** `worker_output_matches_reference_*` drives the real threaded worker, and
`extracted_step_matches_reference_*` the pipeline directly, against a reference copy of the loop
body as it stood before the extraction — frame for frame, all four wire layouts, with settings,
colour-order and room-map changes landing on fixed frames. Both sides call the same stage functions,
so tuning the scene stage or an encoder leaves it green; changing the glue — what runs in which
order, which setting is read where — means updating the reference in the same PR, on purpose.

## Gotchas

- **`AMBILIGHT_CAPTURE_PERMISSION_DENIED` means the macOS Screen Recording permission is missing**, not that capture is broken. It needs a user trip to System Settings, and the app cannot grant it. It is now only produced after a real preflight; a ScreenCaptureKit failure *with* permission granted is `AMBILIGHT_CAPTURE_SHAREABLE_CONTENT_FAILED` instead, usually a wedged `replayd`.
- **`list_displays` needs no permission, so a denied user still sees a full display picker.** It reads Tauri's `available_monitors()`, not ScreenCaptureKit. The picker being populated proves nothing about whether capture will produce frames.
- **Worker lifecycle is traceable in the log and should be read before guessing.** `[apply_mode_change]` for mode activation, `[ambilight-worker]` for the capture worker, `[stop-worker]` and `[stop_previous]` for teardown.
- **A frontend payload arriving without an LED count falls back to the persisted value.** The line `led_calibration fallback engaged — payload_total_leds=0` means the frontend sent nothing usable and the backend read `shell-state.json` instead. The fallback is deliberate — an invalid external input gets an explicit fallback, never a silent default — but it firing on every startup would mean something upstream is wrong.
- **Windows' capture-control `Drop` detaches its stop onto its own thread.** `CaptureControl::stop()` both signals and joins the WGC message-loop thread, an indeterminate wait. That `Drop` runs on the thread executing the mode command during a mode switch, so calling `stop()` inline would freeze the caller — and with it every mode command queued behind it — falsifying the non-blocking contract the macOS sibling (`MacOSLiveFrameSource`) already honours. No grace-period sleep is needed the way macOS needs 150 ms: that sleep guards a DispatchQueue ref-count race specific to `SCStream`, which `windows-capture` has no equivalent of.
- **A capture failure *after* a successful start can only travel through telemetry.** The command already returned `AMBILIGHT_MODE_STARTED`, so no status code is left to carry it. `RuntimeTelemetrySnapshot.last_capture_error_code` holds the reason, sticky for the worker's lifetime, and `last_capture_error_at_secs` is what separates "failing now" from "failed once and recovered" — read them together or a display unplugged an hour ago looks identical to one unplugged a second ago. The failure branch of the worker loop carries its own `flush_if_due` for exactly this reason: the success branch owns the only other flush, so without it a sustained outage would freeze telemetry at the last good frame.
- **The fast-path guard is a list of everything read at worker construction, and adding a field to `LightingModeConfig` means adding it there too.** `apply_mode_change` retunes a running ambilight worker in place — cheap, and the only way a brightness drag is not a worker restart per commit. It can only do that for values the worker reads *live*, from `AmbilightLiveSettings` atomics. `led_calibration`, `color_correction`, `firmware_profile` and `chip_type` are read once, when the encoder and sink are built, so each has to break fast-path equality or the change is silently swallowed: the command returns `AMBILIGHT_MODE_UPDATED`, the UI shows the new setting, and the strip keeps being driven the old way. `chip_type` shipped missing from that list, so selecting SK6812 RGBW left the encoder emitting three bytes per pixel. A frontend-side `force` flag does not help — it only bypasses the frontend's own signature dedupe so the invoke happens at all. `color_order` stays off it as one of those atomics; the one non-atomic field deliberately *not* on the list is `room_geometry`: the worker re-reads it live from the `RoomGeometryLive` cell (one relaxed atomic load per frame, a lock and table rebuild only when its generation moves), and the fast path writes that cell instead — putting it on the list would restart the worker, and the Hue stream with it, on every room-map drag commit. A new field is either on the list or read live through a cell like this one; there is no third option.
- **A running test pattern retunes in place; only its geometry forces a rebuild.** `SyntheticFrameSource` re-reads its pattern and speed from a shared `TestPatternLive` cell every frame, the same way `pattern_phase` already survives a rebuild — so `apply_mode_change` treats a test-to-test change as a fast-path update and writes the cell instead of tearing the worker down. Everything else the source bakes in at construction — the frame size (from `display_aspect`) and the LED sequence — still restarts it, and so does live→test or test→live, because the frame source itself has to change. Before this, every commit of a colour drag was one full worker teardown, which is the only reason the frontend throttle existed; lowering that throttle without the cell would have multiplied rebuilds rather than smoothing anything.
- **Revealing the control popup hides the main shell, and only the preview that hid it may bring it back.** The preview owns the screen while it runs, so `show_led_control_popup` hides `main` — but it records whether it actually hid anything, because the tray opens the preview with the shell already away and closing it must not conjure a window the user never had. `hide_led_control_popup` and the popup's red-X path in `lib.rs` both restore, so the flag is read-and-cleared in one step: whichever gets there second must be inert, or it would raise a window the user had since put away. Note that hiding `main` fires `visibilitychange`, which pauses the Hue polling loops and telemetry until it is shown again — harmless during a test, and worth knowing before reading a gap in the logs as a fault.
- **The worker join happens under the runtime lock on purpose, and moving it out would trade a stall for a crash.** `stop_previous` calls `LightingWorkerRuntime::stop` while the caller still holds `LightingRuntimeState::runtime`, so a ~100–300 ms join delays anything else wanting that lock. That reads like an oversight and is not one. `stop()` takes `self` **by value**, and the ordering is the point: signal `cancel`, join the worker thread so it drops its `Arc` clone, and only then let `self` drop — which releases the last `_frame_source` reference **on the command thread** (a blocking-pool thread since the mode commands went async — see the next entry — and the shutdown's lighting thread on quit; never the worker). That is what keeps `SCStream::stop_capture` off the worker thread, and off it is the difference between a clean teardown and a macOS crash on rapid mode switches. Releasing the lock between stop and start would also let a new `SCStream` be created while the old one is still tearing down — the exact rapid stop/recreate cycle `AmbilightLiveSettings` exists to avoid. The contention is small in practice: besides the mode-change paths themselves (`set_lighting_mode`, `stop_lighting`, the test-pattern start), the holders are `get_lighting_mode_status` and `preview_snapshot`, both status reads, and runtime telemetry polls a different lock entirely. **Do not "fix" this without first moving the frame-source drop somewhere provably safe.**
- **The mode commands are async and take turns, in arrival order.** `set_lighting_mode`, `stop_lighting` and the test-pattern start/stop used to be sync commands, which Tauri runs on the main thread: a worker join, capture setup, the up-to-1 s first-frame wait and the ~2 s bootloader settle froze the whole UI for up to ~3 s. They now run their body on the blocking pool through `run_mode_transition`. The main thread had also been serialising them for free, and the frontend relies on that — quick adjustments are fire-and-forget at 20 Hz, so several commits queue behind one slow transition. The runtime lock alone does not replace it: the payload hydration, the connection snapshot and the `lighting://mode-changed` broadcast all sit outside it, and a std mutex wakes waiters in any order, so the last drag value could land first and the strip settle on a stale one. Hence a second lock, `LightingRuntimeState::transitions`, a `tokio::sync::Mutex` held across the whole blocking body: it is fair (granted in the order `lock()` was called) and may be held across the `.await` on `spawn_blocking`, which a std guard must never be. The shutdown path calls `stop_lighting_blocking` *outside* it — quit must not wait out a queue of mode changes — and the runtime lock still orders it against the one transition in flight. Nothing in capture setup needs the main thread: `CGRequestScreenCaptureAccess`, `SCShareableContent` and the stream start already run off it in the CI capture probe (`smoke_bench.rs`), the `SCStream` stop is detached onto its own thread, and `list_displays` from the test-pattern start reaches Tauri's monitor API, which dispatches to the main thread and waits, as any window getter off it does. `ipc_tests/lighting_commands.rs` holds the turn from a test and proves a queued command neither runs nor broadcasts until it is released, that five commits and a stop apply in the order sent, and that the shutdown stop does not queue.
- **The per-frame budget is shared with whatever else runs per frame.** Anything added to this path competes with capture, colour work, and the send itself. Measure against the existing runtime telemetry before shipping, not after.
