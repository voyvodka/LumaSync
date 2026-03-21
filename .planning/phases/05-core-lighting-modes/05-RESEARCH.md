# Phase 5: Core Lighting Modes - Research

**Researched:** 2026-03-21
**Domain:** Tauri + Rust runtime mode orchestration for Ambilight and solid-color output
**Confidence:** MEDIUM

<user_constraints>
## User Constraints

### Locked Decisions
- No `05-CONTEXT.md` exists yet, so there are no extra locked decisions beyond phase scope.
- Phase goal is fixed: user can switch core lighting modes and LED output follows mode intent.
- Scope is fixed to `MODE-01` and `MODE-02` only.
- Success criteria is fixed:
  1. User can switch to real-time Ambilight screen mirroring mode.
  2. User can switch to a static solid-color mode.
  3. User can change modes without losing saved calibration setup.

### Claude's Discretion
- Choose concrete runtime architecture for mode switching and stream lifecycle.
- Choose screen-capture implementation strategy for Windows-first v1.
- Choose command/state contract between frontend and Rust backend.
- Choose test map and Wave 0 gaps for MODE requirements.

### Deferred Ideas (OUT OF SCOPE)
- Extra effect presets (`MODE-03`) and profile system (`PROF-01`) remain out of this phase.
- Smoothing/adaptive send behavior (Phase 6) is out of scope for this phase.
- Telemetry panel (Phase 7) and stability gate (Phase 8) are out of scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| MODE-01 | User can enable real-time Ambilight screen mirroring mode | Recommends Rust-side capture->sample->serial pipeline, mode command surface, and safe start/stop lifecycle |
| MODE-02 | User can enable a static solid-color mode | Recommends persistent mode settings contract, solid-color payload path, and mode transition rules |
</phase_requirements>

## Summary

Phase 5 should be planned as a runtime mode-engine phase, not a UI-only toggle phase. The project already has a calibration model, a mode guard, and a typed Tauri command bridge. What is missing is a durable "lighting session" contract that can start/stop Ambilight streaming and switch to solid-color output without touching stored calibration.

For this phase, keep the capture/sampling/send loop in Rust, and keep React responsible for intent + settings only. This matches the current architecture (Tauri commands + Rust state + `invoke`) and avoids browser capture limitations such as repeated permission prompts and transient-activation constraints from `getDisplayMedia()`.

Mode switching should be transactional: stop previous runtime job, apply new mode, confirm status, then update UI state. Calibration must stay in `ShellState.ledCalibration` and never be overwritten by mode updates. This is the key implementation guard for success criterion #3.

**Primary recommendation:** Implement a single backend `LightingRuntimeState` with explicit `set_lighting_mode` and `stop_lighting` commands, and run Ambilight capture/sampling in a cancellable Rust worker while preserving calibration as immutable input.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Tauri command bridge (`@tauri-apps/api/core` + `#[tauri::command]`) | `@tauri-apps/api ^2`, `tauri = "2"` | Frontend->backend mode control and status | Already the project-standard IPC path, typed and testable |
| React + TypeScript | `react ^19.1.0`, `typescript ~5.8.3` | Mode UI intent, settings state, and contracts | Existing app shell and settings structure already built on this |
| `serialport` (Rust) | `4` (manifest currently `serialport = "4"`) | Physical LED payload delivery over USB serial | Existing, already used in connection/health flow |
| `windows-capture` (Rust, Windows-first) | `1.5.0` stable line | Real-time frame source for Ambilight mode | Windows-first constraint + explicit frame-arrival API |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Tauri Channels (`tauri::ipc::Channel`, `@tauri-apps/api/core` `Channel`) | Tauri v2 | Ordered status/progress stream (optional for Phase 5) | If mode runtime status must stream frequently to UI |
| Tauri Event API | Tauri v2 | Low-volume status notifications | Use only for small/occasional payloads |
| i18next + react-i18next | `i18next ^25.8.19`, `react-i18next ^16.5.8` | New mode labels/errors EN/TR parity | Any user-visible mode text |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `windows-capture` | `xcap` | `xcap` is cross-platform, but docs/build maturity is more volatile recently; better as future abstraction target |
| Tauri Channels for everything | Tauri Events | Events are simpler, but docs state they are not for low-latency/high-throughput payloads |
| Rust-side native capture | Browser `getDisplayMedia()` | Browser API requires prompt every time + transient user activation; weaker fit for continuous desktop runtime |

**Installation:**
```bash
yarn add @tauri-apps/api
cargo add windows-capture
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── features/mode/
│   ├── model/                     # LightingMode contracts, payload schemas
│   ├── state/                     # reducer/controller for mode selection + status
│   ├── modeApi.ts                 # invoke wrappers for mode commands
│   └── ui/                        # General section mode controls
├── shared/contracts/
│   ├── device.ts                  # command IDs (append, do not fork)
│   └── shell.ts                   # persisted settings additions

src-tauri/src/
├── commands/lighting_mode.rs      # set/stop mode commands and runtime state
├── commands/device_connection.rs  # existing serial connection source of truth
└── lib.rs                         # command registration + managed state
```

### Pattern 1: Single Runtime Owner for Active Mode
**What:** Keep one backend runtime state that owns active mode, worker handle, and cancellation token.
**When to use:** Immediately when adding MODE-01/MODE-02.
**Example:**
```rust
// Source: Tauri state-management + command patterns
#[derive(Clone, serde::Serialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
enum LightingMode {
  Off,
  Ambilight { display_id: String, fps: u16 },
  Solid { r: u8, g: u8, b: u8, brightness: u8 },
}

struct LightingRuntimeState {
  active_mode: std::sync::Mutex<LightingMode>,
  cancel_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
```

### Pattern 2: Transactional Mode Switching
**What:** `set_lighting_mode` always performs `stop_previous -> start_next -> set_active`.
**When to use:** Every mode change request.
**Example:**
```typescript
// Source: project invoke pattern + MODE requirements
import { invoke } from "@tauri-apps/api/core";

export async function setLightingMode(payload: {
  mode: "ambilight" | "solid";
  solidColor?: { r: number; g: number; b: number; brightness: number };
  displayId?: string;
}) {
  return invoke("set_lighting_mode", { payload });
}
```

### Pattern 3: Capture->Sample->Serialize->Send Pipeline
**What:** Ambilight loop computes LED colors from calibration sequence, then sends one frame payload over serial.
**When to use:** `MODE-01` runtime only.
**Example:**
```rust
// Source: windows-capture frame callback model + existing calibration sequence concept
fn on_frame(frame: &[u8], calibration: &LedCalibrationConfig) {
  let led_colors = sample_edges(frame, calibration);
  let packet = build_led_packet(&led_colors);
  send_serial(packet);
}
```

### Anti-Patterns to Avoid
- **Parallel runtimes:** Never allow Ambilight worker and solid-color sender to run concurrently.
- **Mode state in multiple places:** Keep backend as runtime source of truth; frontend mirrors status.
- **Calibration mutation on mode updates:** Mode writes must not touch `ledCalibration` persistence.
- **High-frequency events for frame data:** Do not emit per-frame JSON events to frontend.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Desktop capture backend | Custom Win32/DXGI wrappers from scratch | `windows-capture` crate | Avoids low-level COM/graphics edge-case burden |
| IPC streaming for frequent status | Ad hoc JSON event flood | Tauri Channels | Ordered and designed for streaming |
| Mode persistence merge logic | Manual JSON rewrite path | Existing `loadShellState` + partial `saveShellState` merge | Prevents accidental calibration loss |
| Serial device abstraction split | New duplicate connection state | Existing `SerialConnectionState` ownership | Prevents drift between mode runtime and device truth |

**Key insight:** Mode correctness is mostly lifecycle correctness. Reuse existing state/IPC/storage primitives; spend effort on deterministic mode transition and runtime cancellation.

## Common Pitfalls

### Pitfall 1: Runtime worker leak on mode switch
**What goes wrong:** Old Ambilight loop keeps running after switching to solid mode.
**Why it happens:** No explicit cancellation token or join/stop contract.
**How to avoid:** Enforce stop-before-start in a single backend command path.
**Warning signs:** Serial traffic continues after switching modes.

### Pitfall 2: Calibration loss during mode persistence
**What goes wrong:** Saved calibration disappears after changing mode settings.
**Why it happens:** Full-object overwrite instead of partial merge when saving state.
**How to avoid:** Persist only mode fields; keep `ledCalibration` untouched in store merge.
**Warning signs:** `modeGuard` starts returning `CALIBRATION_REQUIRED` after mode change.

### Pitfall 3: Using Tauri events for frame-rate payloads
**What goes wrong:** UI lag and dropped ordering under high frequency updates.
**Why it happens:** Event system is not optimized for low-latency/high-throughput streams.
**How to avoid:** Keep frame loop backend-only; use channels only for bounded status telemetry.
**Warning signs:** Stuttery UI updates when mode runtime is active.

### Pitfall 4: Browser capture assumptions in desktop runtime
**What goes wrong:** Ambilight start flow breaks without fresh user interaction.
**Why it happens:** `getDisplayMedia()` requires prompt and transient activation per capture start.
**How to avoid:** Use native Rust capture path for runtime mode.
**Warning signs:** Mode start silently fails after app relaunch/background usage.

## Code Examples

Verified patterns from official sources:

### Tauri Command + Managed State
```rust
// Source: https://v2.tauri.app/develop/calling-rust
#[tauri::command]
fn increase_counter(state: tauri::State<'_, std::sync::Mutex<AppState>>) -> u32 {
  let mut state = state.lock().unwrap();
  state.counter += 1;
  state.counter
}
```

### Tauri Channels for Ordered Streaming
```rust
// Source: https://v2.tauri.app/develop/calling-frontend
use tauri::ipc::Channel;

#[tauri::command]
fn stream_status(on_event: Channel<StatusEvent>) {
  on_event.send(StatusEvent::Started).unwrap();
}
```

```typescript
// Source: https://v2.tauri.app/develop/calling-frontend
import { invoke, Channel } from "@tauri-apps/api/core";

const onEvent = new Channel<{ event: string }>();
onEvent.onmessage = (message) => console.log(message.event);
await invoke("stream_status", { onEvent });
```

### Minimal Screen Capture via xcap (alternative reference)
```rust
// Source: https://raw.githubusercontent.com/nashaofu/xcap/master/README.md
use xcap::Monitor;

let monitor = Monitor::all()?.into_iter().next().unwrap();
let image = monitor.capture_image()?;
println!("{}x{}", image.width(), image.height());
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Push frequent updates over global events | Use Tauri Channels for ordered streaming; reserve events for small payloads | Tauri v2 docs (updated 2025-05) | Better runtime reliability under frequent updates |
| Browser-based desktop capture assumptions | Native backend capture for desktop apps | Web API security model (ongoing, MDN updated 2025-11) | Avoids permission/activation friction in persistent runtime |
| Boolean LED toggle (`ledModeEnabled`) | Explicit mode model (`off`/`ambilight`/`solid`) | Needed for MODE-01/MODE-02 | Prevents mode ambiguity and transition bugs |

**Deprecated/outdated:**
- Treating "LED mode" as a single boolean is insufficient once solid-color and ambilight coexist.
- Sending high-frequency frame data over Tauri events is explicitly discouraged by Tauri docs.

## Open Questions

1. **LED serial frame protocol contract for production runtime**
   - What we know: calibration test pattern currently returns status but does not implement full frame payload sending.
   - What's unclear: exact packet framing/checksum/MTU and firmware-side expected cadence.
   - Recommendation: lock protocol in Wave 0 before wiring Ambilight worker.

2. **Capture crate final choice for v1 implementation**
   - What we know: Windows-first constraint favors `windows-capture`; `xcap` remains strong cross-platform candidate.
   - What's unclear: which crate gives best CPU/latency under this app's sampling profile.
   - Recommendation: add a short technical spike benchmark and lock one crate before implementation tasks.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest `^3.0.0` |
| Config file | `vitest.config.ts` |
| Quick run command | `yarn vitest run src/features/mode/state/*.test.ts` |
| Full suite command | `yarn vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| MODE-01 | Switching to Ambilight starts runtime session and marks mode active | unit | `yarn vitest run src/features/mode/state/modeRuntimeFlow.test.ts -t "starts ambilight mode"` | ❌ Wave 0 |
| MODE-01 | Switching away from Ambilight stops previous runtime safely | unit | `yarn vitest run src/features/mode/state/modeRuntimeFlow.test.ts -t "stops previous mode before next"` | ❌ Wave 0 |
| MODE-02 | Switching to solid-color sends static payload and marks mode active | unit | `yarn vitest run src/features/mode/state/modeRuntimeFlow.test.ts -t "switches to solid mode"` | ❌ Wave 0 |
| MODE-02 | Solid-color adjustments update output without clearing calibration | unit | `yarn vitest run src/features/mode/state/modePersistence.test.ts -t "keeps calibration while saving mode"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `yarn vitest run src/features/mode/state/*.test.ts`
- **Per wave merge:** `yarn vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/features/mode/state/modeRuntimeFlow.test.ts` — lifecycle and switch transaction coverage for MODE-01/MODE-02
- [ ] `src/features/mode/state/modePersistence.test.ts` — calibration preservation assertions during mode changes
- [ ] `src/features/mode/modeApi.test.ts` — command payload contract and error mapping tests
- [ ] `src-tauri/src/commands/lighting_mode.rs` unit tests (or extracted pure functions) for mode transition invariants

## Sources

### Primary (HIGH confidence)
- `/websites/v2_tauri_app` (Context7) - calling Rust, managed state, events vs channels guidance
- https://v2.tauri.app/develop/calling-rust/ - Tauri v2 command and `State` usage
- https://v2.tauri.app/develop/calling-frontend/ - events/channels semantics and throughput guidance
- https://v2.tauri.app/plugin/store/ - async store behavior and persistence model
- Local codebase: `src/App.tsx`, `src/features/mode/state/modeGuard.ts`, `src/shared/contracts/shell.ts`, `src/features/shell/windowLifecycle.ts`, `src/features/calibration/state/displayTargetState.ts`, `src-tauri/src/lib.rs`, `src-tauri/src/commands/device_connection.rs`, `src-tauri/src/commands/calibration.rs`

### Secondary (MEDIUM confidence)
- https://docs.rs/windows-capture/latest/windows_capture/ - Windows capture crate API surface
- https://raw.githubusercontent.com/NiiightmareXD/windows-capture/main/README.md - capture capabilities and DXGI support notes
- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia - prompt/transient-activation and security constraints

### Tertiary (LOW confidence)
- https://docs.rs/xcap/latest/xcap/ and https://raw.githubusercontent.com/nashaofu/xcap/master/README.md - cross-platform capture option; maturity/perf needs local validation

## Metadata

**Confidence breakdown:**
- Standard stack: MEDIUM - Tauri and current project stack are high confidence, but capture crate selection needs spike validation
- Architecture: MEDIUM - strongly grounded in existing project patterns, runtime loop details still implementation-dependent
- Pitfalls: HIGH - mostly derived from official Tauri communication constraints and current persistence architecture

**Research date:** 2026-03-21
**Valid until:** 2026-04-20
