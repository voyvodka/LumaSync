# Phase 6: Runtime Quality Controls - Research

**Researched:** 2026-03-21
**Domain:** Ambilight runtime smoothing + adaptive frame/send control in Tauri/Rust
**Confidence:** MEDIUM

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- No `06-CONTEXT.md` file exists, so there are no extra locked decisions beyond the phase brief.
- Phase goal is fixed: realtime mode should feel smoother while runtime load stays controlled.
- Scope is fixed to `QUAL-01` and `QUAL-02`.
- Success criteria is fixed:
  1. Smooth transitions without harsh flicker.
  2. Stable Ambilight behavior with adaptive frame/send load control.
  3. Typical desktop usage should not show noticeable stutter spikes.

### Claude's Discretion
- Select concrete smoothing model and parameters.
- Select adaptive pacing/coalescing strategy for capture/send pipeline.
- Decide where quality controls live in existing Rust runtime architecture.
- Define test strategy and Wave 0 gaps for QUAL requirements.

### Deferred Ideas (OUT OF SCOPE)
- Telemetry UI/panel (`QUAL-03`) is Phase 7.
- 60-minute certification gate (`QUAL-04`) is Phase 8.
- New effect modes/profiles/network transport remain out of scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| QUAL-01 | User gets soft color transitions (smoothing) that avoid harsh flicker | Recommends per-LED temporal smoothing in Rust runtime (EMA/lerp), bounded by configurable response speed and tested with step-change scenarios |
| QUAL-02 | User gets adaptive frame/send behavior (FPS/coalescing) to reduce system load | Recommends paced send gate + frame coalescing + dynamic interval adjustment using measured capture/send timings |
</phase_requirements>

## Summary

Phase 6 should be planned as a runtime-control phase inside `src-tauri/src/commands/lighting_mode.rs`, not as a frontend tuning phase. The current runtime already has transactional mode ownership and a live capture path, but quality controls are missing: there is no temporal smoothing and no adaptive scheduler beyond a fixed `sleep(16ms)` loop.

Evidence from current code shows two load/stability risks that this phase must address directly: (1) ambilight send cadence is fixed and not feedback-driven, and (2) serial output opens the port on every send attempt (`led_output.rs`), which is expensive under high frame rates. Also, the current sampling calibration in runtime uses captured pixel count as LED count, which can explode payload size if not corrected with actual calibration-driven LED count.

The practical planning direction is: keep processing in backend, add a dedicated quality-control layer in the ambilight worker (smoothing + pacing + coalescing), and keep UI state minimal (only durable quality settings if needed). This keeps React simple and puts high-frequency logic where timing control is reliable.

**Primary recommendation:** Implement a Rust-side `RuntimeQualityController` integrated into ambilight worker loop: per-LED smoothing + adaptive send gate + coalesced latest-frame policy, with strict packet-size bounds from actual calibrated LED count.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Tauri command/state (`tauri`, `#[tauri::command]`, `State<Mutex<_>>`) | `tauri = "2"` | Runtime ownership + safe command surface | Already used across connection/calibration/mode runtime and aligns with current architecture |
| Rust std timing/thread primitives (`std::thread`, `std::time::{Duration, Instant}`) | Rust 1.94 std docs baseline | Deterministic pacing and drift-aware scheduling | No new runtime dependency required for Phase 6 baseline |
| `windows-capture` | `1.5.0` in manifest | Live frame source with configurable update interval and dirty-region behavior | Existing capture stack; exposes knobs needed for adaptive load behavior |
| `serialport` | `4` (resolved docs at 4.9.0) | Device output path over USB serial | Existing transport stack and already integrated with runtime |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Tauri Channels | Tauri v2 | Optional low-frequency runtime status stream to frontend | Use only for bounded status updates, not per-frame payloads |
| Vitest | `^3.0.0` | Frontend contract/state tests for new quality config fields | When TS contracts or settings UI are extended |
| Rust built-in test framework (`cargo test`) | Cargo/Rust toolchain | Core correctness tests for smoothing/adaptation math and loop decisions | Primary verification for QUAL-01/02 behavior logic |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `std::thread` paced loop | `tokio` interval tasks | Better async ergonomics, but introduces architectural churn not required for this phase |
| EMA/lerp smoothing | Fixed moving-average windows | Moving average is simple but adds lag and buffering complexity; EMA is lower-memory and responsive |
| Backend-only adaptation | Frontend-driven adaptive knobs every frame | Frontend messaging adds IPC overhead and timing jitter; backend loop is the correct control point |

**Installation:**
```bash
# Baseline Phase 6 plan: no new dependencies required
```

## Architecture Patterns

### Recommended Project Structure
```
src-tauri/src/commands/
├── lighting_mode.rs            # runtime owner + worker lifecycle (existing)
├── runtime_quality.rs          # NEW: smoothing + adaptive pacing pure logic
└── led_output.rs               # packet/serial output bridge (existing)

src/features/mode/
├── model/contracts.ts          # optional quality settings fields in mode payload
└── modeApi.ts                  # command contract updates (if payload evolves)
```

### Pattern 1: Quality Controller as Pure Logic Unit
**What:** Isolate smoothing and adaptive pacing decisions into a pure Rust struct, called by worker loop.
**When to use:** Immediately for QUAL-01/02 to keep loop testable.
**Example:**
```rust
// Source: project runtime pattern + Rust std timing model
pub struct RuntimeQualityController {
    pub target_send_fps: u16,
    pub min_send_interval_ms: u64,
    pub smoothing_alpha: f32,
    last_sent_at: std::time::Instant,
    previous: Vec<[u8; 3]>,
}

impl RuntimeQualityController {
    pub fn smooth(&mut self, next: &[[u8; 3]]) -> Vec<[u8; 3]> {
        if self.previous.len() != next.len() {
            self.previous = next.to_vec();
            return self.previous.clone();
        }
        let a = self.smoothing_alpha.clamp(0.0, 1.0);
        let mut out = Vec::with_capacity(next.len());
        for (prev, cur) in self.previous.iter().zip(next.iter()) {
            let blend = |p: u8, c: u8| ((p as f32) + a * ((c as f32) - (p as f32))).round() as u8;
            out.push([blend(prev[0], cur[0]), blend(prev[1], cur[1]), blend(prev[2], cur[2])]);
        }
        self.previous = out.clone();
        out
    }
}
```

### Pattern 2: Coalesced Latest-Frame Send Gate
**What:** Capture can run fast, but sending is gated; always send only latest available processed frame when gate opens.
**When to use:** Required for QUAL-02 to avoid backlog spikes.
**Example:**
```rust
// Source: Tauri backend runtime pattern + std::thread::sleep behavior docs
if now.duration_since(last_send_at) >= send_interval {
    if let Some(latest_frame) = latest_processed.take() {
        send_frame(latest_frame)?;
        last_send_at = now;
    }
}
```

### Pattern 3: Adaptive Interval from Observed Cost
**What:** Adjust send interval based on rolling capture/send durations and failure pressure.
**When to use:** During active ambilight runtime, each control tick.
**Example:**
```rust
// Source: project requirement QUAL-02 + pacing best-practice
let budget_ms = 1000.0 / target_fps as f32;
let observed_ms = capture_ms_ewma + send_ms_ewma;
let pressure = (observed_ms / budget_ms).clamp(0.5, 2.0);
let adaptive_interval_ms = (base_interval_ms as f32 * pressure).round() as u64;
send_interval = std::time::Duration::from_millis(adaptive_interval_ms.clamp(12, 80));
```

### Anti-Patterns to Avoid
- **Per-frame port open/close in hot path:** avoid repeated `serialport::new(...).open()` for each frame send.
- **Fixed sleep-only pacing:** `thread::sleep(16ms)` alone drifts and oversleeps under load.
- **Queue growth by frame backlog:** never enqueue unbounded frames; keep latest-frame only.
- **LED count derived from full captured pixel count:** must use calibrated LED count to bound packet size and CPU work.
- **Per-frame frontend IPC:** keep high-frequency loop fully backend-side.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Capture driver stack | Custom Win32/DXGI capture plumbing | Existing `windows-capture` stack already integrated | Avoids high-risk graphics API complexity |
| Streaming UI updates | Ad-hoc JSON event flood | Tauri Channels only for bounded status | Events are not for high-throughput/low-latency data |
| Async serial framework migration in-phase | Full transport rewrite in Phase 6 | Incremental optimization on current `serialport` path first | Keeps scope focused on QUAL requirements |
| Flicker suppression heuristics in UI | Frontend-side smoothing loop | Backend per-LED temporal smoothing | Timing and determinism belong to runtime loop |

**Key insight:** QUAL-01/02 are control-loop quality problems. Solve them in one backend quality controller, not by scattering ad-hoc tweaks across UI, capture, and output code.

## Common Pitfalls

### Pitfall 1: Sleep Drift Creates Visible Stutter
**What goes wrong:** Transition smoothness degrades unpredictably during CPU contention.
**Why it happens:** `std::thread::sleep` guarantees minimum sleep, not exact cadence.
**How to avoid:** Use `Instant`-based deadline pacing and adaptive intervals; treat sleep as coarse wait only.
**Warning signs:** Frame/send cadence oscillates and misses cluster under load.

### Pitfall 2: Oversized Payloads from Wrong LED Count
**What goes wrong:** Runtime attempts massive frame packets, increasing latency and CPU.
**Why it happens:** Using captured pixel count as `led_count` instead of calibrated strip count.
**How to avoid:** Resolve LED count from persisted calibration contract and enforce upper bound before encode/send.
**Warning signs:** Packet lengths spike far above physical LED count.

### Pitfall 3: Serial Hot-Path Reopen Cost
**What goes wrong:** Frequent open/flush cycles increase jitter and IO errors.
**Why it happens:** Output bridge opens serial port for each send call.
**How to avoid:** Keep a persistent writable port/session in ambilight runtime, with reconnect-safe fallback.
**Warning signs:** Send latency spikes and intermittent `LED_OUTPUT_PORT_OPEN_FAILED` under sustained runtime.

### Pitfall 4: Over-Smoothing Causes Laggy Ambilight
**What goes wrong:** Colors feel delayed behind screen changes.
**Why it happens:** Aggressive smoothing constants or multi-stage averaging.
**How to avoid:** Clamp smoothing alpha range and validate with step-change tests.
**Warning signs:** Sharp screen transitions take visibly long to settle on LEDs.

## Code Examples

Verified patterns from official sources:

### Tauri Commands with Managed State
```rust
// Source: https://v2.tauri.app/develop/calling-rust/
#[tauri::command]
fn increase_counter(state: tauri::State<'_, std::sync::Mutex<AppState>>) -> u32 {
  let mut state = state.lock().unwrap();
  state.counter += 1;
  state.counter
}
```

### Tauri Channel for Ordered Status Streaming
```rust
// Source: https://v2.tauri.app/develop/calling-frontend/
use tauri::ipc::Channel;

#[tauri::command]
fn stream_status(on_event: Channel<StatusEvent>) {
  on_event.send(StatusEvent::Started).unwrap();
}
```

### windows-capture Settings with Frame-Rate Knob
```rust
// Source: windows-capture README + docs.rs Settings::new
let settings = Settings::new(
    monitor,
    CursorCaptureSettings::Default,
    DrawBorderSettings::Default,
    SecondaryWindowSettings::Default,
    MinimumUpdateIntervalSettings::Default, // default ~60 FPS behavior in README
    DirtyRegionSettings::Default,
    ColorFormat::Rgba8,
    flags,
);
```

### serialport Builder Pattern for Opened Port Handle
```rust
// Source: serialport-rs README + docs.rs serialport::new
let mut port = serialport::new("COM7", 115_200)
    .timeout(std::time::Duration::from_millis(10))
    .open()
    .expect("Failed to open port");

std::io::Write::write_all(&mut port, &packet)?;
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Fixed-rate loop only (`sleep(16ms)`) | Feedback-aware pacing with measured runtime pressure | Recommended for Phase 6 | Lower stutter spikes under variable load |
| Raw sampled colors sent directly | Temporal smoothing before send | Recommended for Phase 6 | Reduced flicker and harsh transitions |
| Send every captured frame | Coalesced latest-frame send gate | Recommended for Phase 6 | Lower CPU/IO pressure without backlog |
| Event-heavy UI status updates | Backend-local hot loop + optional bounded status stream | Tauri v2 guidance | Better runtime reliability |

**Deprecated/outdated:**
- Treating capture cadence and send cadence as the same loop should be avoided for QUAL-02.
- Opening serial port per frame is acceptable for low-frequency commands but poor for realtime ambilight output.

## Open Questions

1. **What is the firmware-safe max payload cadence and LED count budget?**
   - What we know: packet format is fixed in `led_output.rs`; runtime currently does not expose transport budget limits.
   - What's unclear: sustained send FPS threshold before firmware/controller starts dropping or blocking.
   - Recommendation: add a short hardware profiling task early in Phase 6 planning and lock send interval bounds.

2. **Where should persistent serial session lifecycle live?**
   - What we know: `LedOutputBridge` currently opens port per send.
   - What's unclear: best ownership boundary (inside `LightingRuntimeOwner` vs sender implementation) for reconnect-safe persistent handle.
   - Recommendation: decide ownership in first plan and keep it isolated behind `LedPacketSender` trait.

3. **How should quality settings be surfaced to user in v1?**
   - What we know: requirements require behavior, not necessarily new UI controls.
   - What's unclear: whether defaults-only is enough or a small advanced tuning surface is needed.
   - Recommendation: ship safe defaults first; defer UI exposure unless verification needs manual tuning.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust unit tests (`cargo test`) + Vitest `^3.0.0` |
| Config file | `vitest.config.ts` (frontend), none extra for Rust unit tests |
| Quick run command | `cargo test --manifest-path src-tauri/Cargo.toml lighting_mode::tests:: -- --nocapture` |
| Full suite command | `cargo test --manifest-path src-tauri/Cargo.toml && yarn vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| QUAL-01 | Step-change colors are smoothed (no harsh single-frame jumps) while converging in bounded time | unit (Rust) | `cargo test --manifest-path src-tauri/Cargo.toml runtime_quality::tests::smoothes_step_changes` | ❌ Wave 0 |
| QUAL-01 | Smoothing resets correctly on LED-count change and does not panic | unit (Rust) | `cargo test --manifest-path src-tauri/Cargo.toml runtime_quality::tests::resets_on_led_count_change` | ❌ Wave 0 |
| QUAL-02 | Adaptive gate lowers send cadence when observed processing cost rises | unit (Rust) | `cargo test --manifest-path src-tauri/Cargo.toml runtime_quality::tests::adapts_interval_under_pressure` | ❌ Wave 0 |
| QUAL-02 | Coalescing keeps queue bounded (latest-frame policy) under capture bursts | unit (Rust) | `cargo test --manifest-path src-tauri/Cargo.toml runtime_quality::tests::coalesces_to_latest_frame` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `cargo test --manifest-path src-tauri/Cargo.toml runtime_quality::tests::`
- **Per wave merge:** `cargo test --manifest-path src-tauri/Cargo.toml lighting_mode::tests:: runtime_quality::tests::`
- **Phase gate:** `cargo test --manifest-path src-tauri/Cargo.toml && yarn vitest run` green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/commands/runtime_quality.rs` - pure quality controller + focused unit tests for QUAL-01/02
- [ ] `src-tauri/src/commands/lighting_mode.rs` - integration-level worker tests covering adaptive gating decisions
- [ ] `src/features/mode/model/contracts.test.ts` - if quality config fields are added, normalize/contract coverage for TS side

## Sources

### Primary (HIGH confidence)
- `/websites/v2_tauri_app` (Context7) - command/state usage and channels/events guidance
- `/serialport/serialport-rs` (Context7) - builder/open usage and `SerialPort` capabilities
- `/niiightmarexd/windows-capture` (Context7) - capture handler model and settings usage
- https://v2.tauri.app/develop/calling-rust/ - managed state and command patterns
- https://v2.tauri.app/develop/calling-frontend/ - event vs channel behavior and limits
- https://docs.rs/serialport/latest/serialport/fn.new.html - builder/open API
- https://docs.rs/serialport/latest/serialport/trait.SerialPort.html - serial trait methods and notes
- https://docs.rs/windows-capture/latest/windows_capture/settings/struct.Settings.html - capture settings constructor and arguments
- https://docs.rs/windows-capture/latest/windows_capture/settings/enum.MinimumUpdateIntervalSettings.html - interval control enum
- Local codebase: `src-tauri/src/commands/lighting_mode.rs`, `src-tauri/src/commands/led_output.rs`, `src-tauri/src/commands/ambilight_capture.rs`, `src/features/mode/model/contracts.ts`

### Secondary (MEDIUM confidence)
- https://raw.githubusercontent.com/NiiightmareXD/windows-capture/main/README.md - practical defaults and capture usage notes
- https://doc.rust-lang.org/std/thread/fn.sleep.html - sleep timing caveats used for pacing pitfalls

### Tertiary (LOW confidence)
- https://docs.hyperion-project.org/user/advanced/Advanced.html - ecosystem reference (layout/processing context only; no direct smoothing contract extracted)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - directly grounded in current repo and official docs/Context7.
- Architecture: MEDIUM - control-loop pattern is solid, but exact adaptive thresholds require hardware profiling.
- Pitfalls: MEDIUM - strongly evidenced by current code and docs, but field behavior depends on controller firmware limits.

**Research date:** 2026-03-21
**Valid until:** 2026-04-20
