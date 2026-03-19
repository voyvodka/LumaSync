# Architecture Research

**Domain:** Desktop Ambilight (USB-serial WS2812B controller)
**Researched:** 2026-03-19
**Confidence:** HIGH

## Standard Architecture

### System Overview

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                         App Shell (Desktop UI)                            │
├────────────────────────────────────────────────────────────────────────────┤
│  Tray + Wizard + Advanced Panel                                           │
│  - Start/stop mode                                                        │
│  - Calibration editor                                                     │
│  - Profile management                                                     │
└───────────────┬────────────────────────────────────────────────────────────┘
                │ IPC / command bus
┌───────────────▼────────────────────────────────────────────────────────────┐
│                     Runtime Orchestrator (Core Process)                   │
├────────────────────────────────────────────────────────────────────────────┤
│  Session Manager  |  Device Manager  |  Health + Recovery                 │
│  (mode state)     |  (serial lifecycle)| (timeouts, reconnect, watchdog)  │
└───────┬───────────────────────┬───────────────────────────────┬────────────┘
        │                       │                               │
┌───────▼────────┐     ┌────────▼─────────┐            ┌────────▼──────────┐
│ Capture Engine │ --> │ Color Pipeline   │ --> frame  │ Transport Adapter │
│ (screen frames)│     │ sample/map/smooth│            │ (Adalight serial) │
└───────┬────────┘     └────────┬─────────┘            └────────┬──────────┘
        │                        │                                │
        │                        │                                │ USB serial
┌───────▼────────────────────────▼────────────────────────────────▼──────────┐
│                   Local Data + Hardware Boundary                           │
├────────────────────────────────────────────────────────────────────────────┤
│  Profiles/Settings Store        Arduino Firmware (FastLED + Adalight)     │
│  Logs + crash-safe state        WS2812B Strip                              │
└────────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| App Shell | Wizard, calibration UX, tray controls, profile CRUD | Desktop UI window + tray process; communicates only through orchestrator API |
| Runtime Orchestrator | Source of truth for active mode/session; starts/stops pipeline safely | Single state machine with explicit states (`idle`, `capturing`, `streaming`, `recovering`) |
| Capture Engine | Acquire screen frames on interval with monitor selection | Windows capture backend (Desktop Duplication or Windows.Graphics.Capture wrapper) |
| Color Pipeline | Convert frame to LED colors (zones -> averages -> correction -> smoothing) | Pure compute pipeline, testable without UI/hardware |
| Transport Adapter | Serialize LED frame payload and write to USB serial protocol | Adalight packet framer + serial write queue + backpressure handling |
| Device Manager | Auto-detect COM ports, handshake, reconnect, health monitoring | Serial port scanner + open/close lifecycle + retry policy |
| Settings/Profile Store | Persist layout, color settings, transport settings, presets | Local file DB/JSON with schema versioning and migration |
| Firmware Boundary | Convert packets into LED output, enforce frame timeout safety | Arduino sketch (Adalight + FastLED) with OFF timeout fallback |

## Recommended Project Structure

```text
src/
├── app/                      # Desktop shell (tray + windows + routing)
│   ├── tray/                 # Tray lifecycle and commands
│   ├── wizard/               # First-run guided setup
│   └── settings/             # Advanced panel UI
├── core/                     # Runtime orchestration and domain logic
│   ├── session/              # State machine and mode orchestration
│   ├── capture/              # OS capture providers + monitor handling
│   ├── pipeline/             # Sampling, mapping, smoothing, calibration
│   ├── transport/            # Protocol framing and output adapters
│   └── device/               # Serial discovery, handshake, reconnect
├── shared/                   # Shared DTOs, schemas, constants, validation
├── data/                     # Profile store, config migrations, backups
├── diagnostics/              # Logging, metrics, debug snapshots
└── platform/
    └── windows/              # Windows-specific capture/interop glue
```

### Structure Rationale

- **`core/`** keeps Ambilight logic independent from UI framework, so runtime can be tested headlessly.
- **`capture/` and `transport/`** are hard boundaries to swap platform/provider implementations later (network transport, macOS capture).
- **`shared/`** prevents drift between wizard, advanced panel, and runtime contracts.
- **`platform/windows/`** isolates Windows-first interop debt from domain code.

## Architectural Patterns

### Pattern 1: Pipeline + State Machine (recommended baseline)

**What:** Frame processing runs as a deterministic pipeline controlled by a session state machine.
**When to use:** Always for real-time desktop Ambilight; this keeps behavior predictable during disconnects and mode switches.
**Trade-offs:** Slightly more boilerplate than ad-hoc callbacks, but much safer under long-running sessions.

**Example:**
```typescript
type SessionState = 'idle' | 'capturing' | 'streaming' | 'recovering';

function onFrame(frame: RawFrame, cfg: RuntimeConfig) {
  const sampled = sampleZones(frame, cfg.layout);
  const corrected = applyCalibration(sampled, cfg.color);
  const smoothed = smoothFrame(corrected, cfg.smoothing);
  const packet = encodeAdalight(smoothed);
  serialQueue.enqueue(packet);
}
```

### Pattern 2: Adapter Interfaces for Capture and Transport

**What:** `CaptureProvider` and `OutputTransport` interfaces hide OS/protocol details from core logic.
**When to use:** From day one; Windows-first now, but macOS/Linux and network outputs are likely future milestones.
**Trade-offs:** Adds abstraction upfront, but prevents rewrite when adding new backends.

**Example:**
```typescript
interface CaptureProvider {
  start(monitorId: string): AsyncIterable<RawFrame>;
  stop(): Promise<void>;
}

interface OutputTransport {
  connect(target: DeviceRef): Promise<void>;
  send(colors: RgbFrame): Promise<void>;
  disconnect(): Promise<void>;
}
```

### Pattern 3: Write Queue + Backpressure for Serial Output

**What:** Transport writes through a bounded queue, respecting drain/error/close events.
**When to use:** USB serial streaming at stable FPS; avoids memory growth and jitter.
**Trade-offs:** Can drop or coalesce frames under pressure; must define policy clearly.

## Data Flow

### Runtime Flow (Ambilight mode)

```text
[User starts Ambilight]
        |
        v
[Orchestrator validates config + active profile]
        |
        v
[Capture Engine emits frame]
        |
        v
[Color Pipeline: zones -> average -> calibration -> smoothing]
        |
        v
[Transport: frame -> Adalight packet -> serial write queue]
        |
        v
[Arduino firmware parses packet -> FastLED.show() -> WS2812B output]
```

### Control/Data Separation

```text
Control plane: UI -> Orchestrator -> Device/Capture/Transport lifecycle
Data plane:    Capture frames -> Color pipeline -> Serial packets -> LEDs
```

### Key Data Flows

1. **Calibration flow:** Wizard/advanced panel updates layout -> persisted profile -> next pipeline tick consumes new mapping.
2. **Device lifecycle flow:** Port scan -> handshake -> connected -> stream -> disconnect detected -> recover/backoff -> resume.
3. **Mode arbitration flow:** Effect mode or solid color can preempt capture stream via orchestrator priority/state policy.

## Component Boundaries (what talks to what)

| Boundary | Communication | Rule |
|----------|---------------|------|
| App Shell <-> Runtime Orchestrator | IPC/request-response + events | UI never touches serial or capture APIs directly |
| Orchestrator <-> Capture Engine | Provider interface + async frames | Capture is pull/push via typed frame contract only |
| Orchestrator <-> Color Pipeline | In-process function calls | Pipeline remains pure, no I/O side effects |
| Orchestrator <-> Transport Adapter | Command + queued send | Transport owns retries/backpressure; orchestrator owns policy |
| Transport Adapter <-> Device Manager | Device session callbacks | Single owner of port handle at all times |
| Runtime <-> Store | Repository API | No direct file writes outside data module |

## Suggested Build Order (dependencies)

1. **Domain contracts + state machine skeleton**
   - Define frame model, LED layout model, profile schema, session states.
   - Dependency reason: every later module needs these stable contracts.

2. **Transport + Device Manager (USB serial baseline)**
   - Implement COM detection, open/close, Adalight framing, basic heartbeat/reconnect.
   - Dependency reason: gives hardware feedback early and validates firmware path before capture complexity.

3. **Color Pipeline (offline frames first)**
   - Implement mapping, averaging, calibration, smoothing with fixture images.
   - Dependency reason: verify visual quality independently from capture backend.

4. **Capture Engine (Windows backend)**
   - Add monitor selection, frame cadence, resize/rotation handling.
   - Dependency reason: now pipeline + transport are ready, so end-to-end integration is straightforward.

5. **Orchestrator integration and recovery policies**
   - Wire capture -> pipeline -> transport; implement disconnect and restart logic.
   - Dependency reason: this is the first full runtime path.

6. **UI shell (wizard, advanced panel, tray)**
   - Build setup and operations UI on top of stable runtime APIs.
   - Dependency reason: avoids UI churn while runtime contracts are moving.

7. **Diagnostics + profile import/export hardening**
   - Add logs, crash-safe state restore, config backup/restore.
   - Dependency reason: required for long-session reliability target.

## Anti-Patterns

### Anti-Pattern 1: UI-driven frame processing

**What people do:** Run capture and color math inside renderer/UI event loops.
**Why it's wrong:** UI stalls cause frame jitter and dropped writes.
**Do this instead:** Keep pipeline in core runtime process/worker; UI sends only control commands.

### Anti-Pattern 2: Direct serial writes from multiple modules

**What people do:** Wizard test mode and runtime both write directly to COM port.
**Why it's wrong:** Port contention and nondeterministic output.
**Do this instead:** Single transport owner with explicit mode arbitration.

### Anti-Pattern 3: No explicit recovery state

**What people do:** Handle disconnect as generic error popup.
**Why it's wrong:** Breaks 1-hour stability expectation and requires manual restart.
**Do this instead:** `recovering` state with bounded retry and automatic resume.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Windows screen capture APIs | Capture provider backend | Desktop Duplication and Windows.Graphics.Capture both expose GPU-friendly frame streams |
| USB serial stack | Serial transport backend | Must handle `open`, `close`, `error`, `drain` events for robust streaming |
| Arduino firmware (Adalight + FastLED) | Packet protocol boundary | Host sends `Ada` prefix + length/checksum + RGB payload; firmware enforces timeout safety |

## Confidence Notes

- **HIGH:** Core pipeline shape (capture -> process -> map -> smooth -> transport -> firmware) is consistently evidenced in Hyperion docs/code and Adalight firmware.
- **HIGH:** Windows capture and serial lifecycle requirements are documented in Microsoft Learn and SerialPort docs.
- **MEDIUM:** Exact implementation details for a specific desktop framework (Electron/Tauri/.NET) vary; boundaries remain valid across stacks.

## Sources

- Hyperion Introduction and features (priority channels, low CPU, API): https://docs.hyperion-project.org/user/Introduction.html (HIGH)
- Hyperion advanced LED layout model (`hmin/hmax/vmin/vmax`, ordered LEDs): https://docs.hyperion-project.org/user/advanced/Advanced.html (HIGH)
- Hyperion LED hardware categories, USB/Serial support, retries and autostart concepts: https://docs.hyperion-project.org/user/leddevices/Overview.html and https://docs.hyperion-project.org/user/Configuration.html (HIGH)
- Hyperion Adalight device notes + reference firmware link: https://docs.hyperion-project.org/user/leddevices/usb/adalight.html (HIGH)
- Hyperion reference code structure (capture, image processor, muxer, smoothing, leddevice modules): https://github.com/hyperion-project/hyperion.ng (HIGH)
- Hyperion Adalight Arduino sketch (`Ada` magic word, checksum, serial rate, `FastLED.show()`): https://github.com/hyperion-project/hyperion.ng/blob/master/assets/firmware/arduino/adalight/adalight.ino (HIGH)
- Microsoft Desktop Duplication API (`AcquireNextFrame`, dirty/move rects, rotation handling): https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api (HIGH, updated 2025-04-15)
- Microsoft Windows.Graphics.Capture frame/session model and `StartCapture`: https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture (HIGH, updated 2025-06-10)
- Electron docs via Context7 (`desktopCapturer`, IPC bridge, tray architecture): `/electron/electron` (MEDIUM-HIGH)
- SerialPort docs via Context7 (`open/error/close/drain`, write/backpressure behavior): `/serialport/website` (MEDIUM-HIGH)

---
*Architecture research for: LumaSync*
*Researched: 2026-03-19*
