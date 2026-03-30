# Architecture Research

**Domain:** LumaSync v1.2 — Room Visualization and Universal Light Management
**Researched:** 2026-03-30
**Confidence:** HIGH (direct codebase analysis, no external research required)

---

## v1.2 Integration Overview

This document focuses exclusively on how the five v1.2 feature areas integrate with the existing
LumaSync architecture. The baseline architecture (contract-first Tauri 2 + React 19 + plugin-store)
is stable and documented in `CLAUDE.md`. What follows addresses the five questions posed by the
milestone: room map state, new Tauri commands, LED zone derivation, build order, and standalone mode.

---

## Existing Architecture Baseline

```
┌────────────────────────────────────────────────────────────┐
│                  Frontend (React 19 / TypeScript)           │
│  ┌──────────┐ ┌────────────┐ ┌─────────┐ ┌─────────────┐  │
│  │ settings/│ │calibration/│ │  mode/  │ │  device/    │  │
│  │ sections │ │   ui/      │ │ state/  │ │ hueOnboard  │  │
│  └────┬─────┘ └─────┬──────┘ └────┬────┘ └──────┬──────┘  │
│       │              │            │              │          │
│  ┌────┴──────────────┴────────────┴──────────────┴──────┐  │
│  │        src/shared/contracts/ (type-only, no logic)    │  │
│  │    hue.ts   device.ts   shell.ts   display.ts         │  │
│  └────────────────────────┬──────────────────────────────┘  │
├───────────────────────────┼────────────────────────────────┤
│               Tauri invoke() bridge                         │
├───────────────────────────┼────────────────────────────────┤
│          Rust Backend (src-tauri/src/commands/)             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ hue_onboard  │  │ hue_stream   │  │lighting_mode │     │
│  │ ing.rs       │  │_lifecycle.rs │  │.rs           │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │calibration.rs│  │device_conn   │  │runtime_tele  │     │
│  │              │  │ection.rs     │  │metry.rs      │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
├────────────────────────────────────────────────────────────┤
│  Persistence: Tauri plugin-store → ~/.config/lumasync/app.json │
│  ShellState (shell.ts) — single JSON blob, SHELL_STORE_KEY      │
└────────────────────────────────────────────────────────────┘
```

### Component Responsibilities (existing, for reference)

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| `src/shared/contracts/` | Type-only source of truth for all command names, status codes, persisted state shape | Pure TypeScript interfaces and const maps; no runtime logic |
| `src/features/device/hueOnboardingApi.ts` | Frontend bridge for all Hue onboarding commands (discover, pair, validate, list areas, get channels) | `invoke()` wrappers around `HUE_COMMANDS` const map |
| `src-tauri/src/commands/hue_onboarding.rs` | One-shot CLIP v2 HTTP commands (no runtime state) | `reqwest` async, `hue_http_client()` helper |
| `src-tauri/src/commands/hue_stream_lifecycle.rs` | DTLS streaming worker, `HueRuntimeStateStore`, reconnect loop | Long-lived Tauri State, background threads |
| `src/features/calibration/model/contracts.ts` | `LedCalibrationConfig` type + normalize/parse functions | Pure TypeScript |
| `src/features/mode/state/modeGuard.ts` | LED mode enable guard (requires calibration) | Pure function, no Tauri calls |
| `ShellState` in `shell.ts` | All persisted UI state | plugin-store single key `"shell-state"` |

---

## Feature Integration Analysis

### Feature 1: Room Map (2D) — Where State Lives

**Answer: Frontend React state + plugin-store persistence. No new Rust state.**

The room map is spatial metadata (light positions, floor plan dimensions). The Rust backend does not
need to know about it at all — the map informs LED calibration derivation and Hue channel position
writes, both of which already have or will have dedicated command interfaces.

**State residence breakdown:**

| Data | Owner | Persistence |
|------|-------|-------------|
| Room floor plan dimensions, LED strip wall placement, future light sources | Frontend `roomMapStore.ts` | `ShellState.roomMap` in plugin-store |
| Hue channel xy positions (bridge-authoritative) | Rust `HueRuntimeStateStore` cache OR live bridge fetch | NOT persisted locally; fetched via `get_hue_area_channels` |
| User-edited channel xy (dirty state during active edit session) | Frontend local React state (`useState`) | Discarded on cancel; written to bridge on explicit "save" |
| Hue channel region overrides (existing) | `ShellState.hueChannelRegionOverrides` (already in `shell.ts` line 130) | Already persisted |

**New `ShellState` additions** (`src/shared/contracts/shell.ts`):

```typescript
// Add to ShellState interface:
roomMap?: RoomMapConfig;
roomMapVersion?: number;   // bump on structural changes to enable migration
```

`RoomMapConfig` is defined in a new contract file `src/shared/contracts/roomMap.ts`.

**New feature module:**
```
src/features/roomMap/
├── model/
│   └── contracts.ts        // RoomMapConfig, LightSourcePlacement, RoomDimensions
├── state/
│   ├── roomMapStore.ts     // React state + shellStore read/write
│   └── zoneDerivation.ts   // Pure function: RoomMapConfig -> LedCalibrationConfig
└── ui/
    ├── RoomMapEditor.tsx   // Drag/drop 2D canvas (new UI surface)
    └── LightSourceDot.tsx  // Draggable light icon component
```

A new settings sidebar section (`SECTION_IDS.ROOM_MAP`) is needed in `shell.ts` to host
`RoomMapEditor`. `SECTION_ORDER` must be updated accordingly.

---

### Feature 2: Hue Channel Position Editor — New Tauri Commands

**One new Tauri command required: `update_hue_channel_positions`.**

The READ path already exists. `get_hue_area_channels` (implemented at `hue_stream_lifecycle.rs:1466`)
serves `HueAreaChannelInfo[]` with `positionX/positionY`. It uses a runtime cache fast-path and
falls back to a live bridge fetch — no changes needed to the read side.

**New WRITE command:**

The Hue CLIP v2 endpoint for writing channel positions is:
```
PUT https://{bridge_ip}/clip/v2/resource/entertainment_configuration/{area_id}
```
Body must include the `channels` array with updated `position.x / y / z` per channel.

**Module placement:** `hue_onboarding.rs` (NOT `hue_stream_lifecycle.rs`). Channel position
configuration is a one-shot HTTP operation, not a streaming concern. The lifecycle module owns
the DTLS worker and runtime state — keep it separate.

After a successful write, the runtime channel cache in `HueRuntimeStateStore` must be invalidated
so the next `get_hue_area_channels` call reflects the new positions.

**New contract additions:**

`src/shared/contracts/hue.ts` — add to `HUE_COMMANDS`:
```typescript
UPDATE_CHANNEL_POSITIONS: "update_hue_channel_positions",
```

`src/shared/contracts/hue.ts` — add to `HUE_STATUS` (or a new `HUE_CONFIG_STATUS` group):
```typescript
CHANNEL_POSITIONS_UPDATED: "HUE_CHANNEL_POSITIONS_UPDATED",
CHANNEL_POSITIONS_FAILED:  "HUE_CHANNEL_POSITIONS_FAILED",
```

**New frontend API function** (`src/features/device/hueOnboardingApi.ts`):
```typescript
updateHueChannelPositions(
  bridgeIp: string,
  username: string,
  areaId: string,
  positions: Array<{ channelIndex: number; x: number; y: number; z: number }>
): Promise<HueUpdateChannelPositionsResponse>
```

**UI surface:** The position editor extends the existing `HueChannelMapPanel.tsx`. The panel
already renders xy dots and handles region string overrides — the position editing mode adds a
drag-to-reposition interaction and a "Save to bridge" button. These are additive; the existing
region override path (`hueChannelRegionOverrides` in `ShellState`) is unchanged.

---

### Feature 3: LED Zone Auto-Derivation — Interaction with Calibration Contracts

**No new Tauri commands. No calibration contract changes. Pure frontend computation.**

`LedCalibrationConfig` (in `src/features/calibration/model/contracts.ts`) already has the right
shape to express zone derivation output:
- `counts: LedSegmentCounts` — top/right/bottom/left LED counts per segment
- `startAnchor: LedStartAnchor` — physical start position on the strip
- `direction: LedDirection` — cw/ccw winding

Derivation reads `RoomMapConfig.ledStripPlacement` (new) and produces a `LedCalibrationConfig`.
The output flows through the existing `onCalibrationSaved` callback path in `App.tsx` — the user
reviews it in `CalibrationPage` before it is persisted.

**New file:** `src/features/roomMap/state/zoneDerivation.ts`

```typescript
// Pure function — no Tauri calls, no side effects, fully unit-testable
function deriveCalibrationFromRoomMap(
  roomMap: RoomMapConfig,
  displayAspectRatio: number,
): LedCalibrationConfig | null
// Returns null when ledStripPlacement is absent or insufficient
```

**Data flow:**
```
RoomMapConfig.ledStripPlacement
    |
    v  deriveCalibrationFromRoomMap()
LedCalibrationConfig (suggested — user reviews, not auto-applied)
    |
    v  User confirms in CalibrationPage (existing "Save" action)
onCalibrationSaved()  [App.tsx, line ~74 in SettingsLayout.tsx prop chain]
    |
    v
ShellState.ledCalibration  [existing plugin-store key]
    |
    v
start_calibration_test_pattern / set_lighting_mode  [existing Rust commands]
```

The derivation result is NEVER silently written. It is presented as `initialConfig` to the existing
`CalibrationPage` component, which already handles user review and save. No new save path needed.

---

### Feature 4: Hue Standalone Mode — Mode State Machine and Startup Changes

**This feature has the widest blast radius across existing modules.**

**Current state analysis:**

1. `modeGuard.ts` — `canEnableLedMode()` blocks mode enable if `calibration` is absent. This guard
   assumes USB is always the output target.
2. `OutputTargetsPanel.tsx` line 46 — `isLastSelected` prevents deselecting the last active target.
   A user with `targets = ["hue"]` cannot deselect Hue even when they want USB-only mode.
3. `lighting_mode.rs` — the Rust `set_lighting_mode` command implicitly assumes a USB device is
   present for Ambilight/Solid modes. There is no concept of "skip USB checks" in the current
   request type.

**Required changes per module:**

**`src/features/mode/state/modeGuard.ts` (MODIFY)**

Add a parallel guard function:
```typescript
function canEnableHueStandaloneMode(hueConfigured: boolean): HueModeGuardResult
```
The routing logic in `App.tsx` must invoke the correct guard based on whether `outputTargets`
includes `"usb"`. The existing `canEnableLedMode` and `resolveLedModeEnableAttempt` functions
remain unchanged for USB-inclusive paths.

**`src/features/settings/sections/control/OutputTargetsPanel.tsx` (MODIFY)**

The `isLastSelected` guard (line 46) must be relaxed so that `["hue"]` alone is valid when USB
is not connected:
```typescript
// Current:
const isLastSelected = selected && outputTargets.length === 1;
const isDisabled = disabled || !available || isLastSelected;

// v1.2: allow hue-only when usb is not connected
const isLastSelected = selected && outputTargets.length === 1 && id !== "usb";
```
No new props needed — `usbConnected` is already threaded through.

**`src/shared/contracts/shell.ts` (NO CHANGE)**

`lastOutputTargets?: HueRuntimeTarget[]` already persists target selection. `["hue"]` is a valid
existing value. Standalone mode is just this persisted state being `["hue"]` without `"usb"`.

**`src-tauri/src/commands/lighting_mode.rs` (MODIFY — most significant Rust change)**

`LightingModeConfig` or a new `SetLightingModeRequest` wrapper must carry `targets: Vec<String>`
so the Rust handler knows which outputs to activate. When `targets` does not include `"usb"`, the
serial port existence check must be skipped and the USB worker must not be spawned.

New request struct:
```rust
#[derive(Deserialize)]
pub struct SetLightingModeRequest {
    pub config: LightingModeConfig,
    pub targets: Vec<String>,  // ["usb"], ["hue"], or ["usb", "hue"]
}
```

**`src/shared/contracts/hue.ts` (NO CHANGE)**

`HueRuntimeTarget = "hue" | "usb"` already covers standalone mode.

**Startup flow for standalone mode:**
```
ShellState.lastOutputTargets = ["hue"]  (persisted from previous session)
    |
    v  App.tsx hydration
resolveHueRuntimePlan({ action: "start", selectedTargets: ["hue"] })
    |
    v  No USB guard triggered (targets does not include "usb")
set_lighting_mode({ config: {...}, targets: ["hue"] })
    |
    v  Rust: skips serial port checks, routes to start_hue_stream only
    v  USB worker is never spawned
HUE stream starts; USB device absence is not an error
```

---

### Feature 5: Carried-Over HUX-01/02, HUE-08, HDR-01/02

These are refinements to existing surfaces, not new components. Listed here with their exact
integration points to avoid scope ambiguity.

| Item | Current location | Change type | Notes |
|------|-----------------|-------------|-------|
| HUE-08 fault recovery | `hue_stream_lifecycle.rs` reconnect loop + `hueModeRuntimeFlow.ts` | MODIFY (Rust): improve retry backoff; MODIFY (TS): surface `actionHint` correctly | `TRANSIENT_RETRY_SCHEDULED` and `TRANSIENT_RETRY_EXHAUSTED` status codes already exist in `hue.ts` |
| HUX-01 Hue status in DeviceSection | `DeviceSection.tsx` + `hueRuntimeStatusCard.ts` | ADDITIVE: expose more runtime state signals | Current `DeviceSection.tsx` already imports `buildHueRuntimeStatusCard` |
| HUX-02 switch USB↔Hue without losing state | `OutputTargetsPanel.tsx` + `modeRuntimeFlow.ts` | LOGIC: preserve `lightingMode.solid`/`ambilight` payload when switching targets | `mergeLightingModeIntoShellState` in `modeRuntimeFlow.ts` already preserves payloads across mode changes — verify it covers target-switch case |
| HDR-01 coded error states | `hue.ts` (`HUE_RUNTIME_STATUS` codes) + `DeviceSection.tsx` | CONTRACT extension + UI copy | `AUTH_INVALID_CREDENTIALS`, `CONFIG_NOT_READY_GATE_BLOCKED` already exist; may need new Hue-unreachable codes |
| HDR-02 Hue stream health signals | `runtime_telemetry.rs` + `TelemetrySection.tsx` | ADDITIVE telemetry fields | Follow the existing `RuntimeTelemetrySnapshot` pattern |

---

## Recommended Project Structure (new additions only)

```
src/
├── features/
│   ├── roomMap/                         # NEW feature module
│   │   ├── model/
│   │   │   └── contracts.ts             # RoomMapConfig, LightSourcePlacement, RoomDimensions
│   │   ├── state/
│   │   │   ├── roomMapStore.ts          # React state + shellStore facade (read/write RoomMapConfig)
│   │   │   └── zoneDerivation.ts        # Pure: RoomMapConfig -> LedCalibrationConfig
│   │   └── ui/
│   │       ├── RoomMapEditor.tsx        # Drag/drop canvas (new UI surface)
│   │       └── LightSourceDot.tsx       # Draggable light icon
│   │
│   ├── mode/
│   │   └── state/
│   │       └── modeGuard.ts             # MODIFY: add canEnableHueStandaloneMode()
│   │
│   └── settings/
│       └── sections/
│           ├── HueChannelMapPanel.tsx   # MODIFY: add position edit mode + save-to-bridge
│           └── control/
│               └── OutputTargetsPanel.tsx # MODIFY: relax isLastSelected guard
│
├── shared/
│   └── contracts/
│       ├── hue.ts                       # MODIFY: add UPDATE_CHANNEL_POSITIONS command + status codes
│       ├── shell.ts                     # MODIFY: add roomMap?, roomMapVersion?; add ROOM_MAP section ID
│       └── roomMap.ts                   # NEW: RoomMapConfig, LightSourcePlacement types
│
src-tauri/src/commands/
├── hue_onboarding.rs                    # MODIFY: add update_hue_channel_positions command
└── lighting_mode.rs                     # MODIFY: add targets field to SetLightingModeRequest
```

---

## Architectural Patterns

### Pattern 1: Contract-First Extension

**What:** Every new Tauri command, `ShellState` field, and status code is defined in
`src/shared/contracts/` BEFORE any implementation. The `scripts/verify/phase01-shell-contracts.mjs`
validator enforces Rust-TS alignment.

**When to use:** Without exception for every cross-boundary change in this milestone.

**Trade-offs:** Adds a contract-writing step before code; prevents serialization mismatches that only
surface at runtime.

**Example:**
```typescript
// src/shared/contracts/hue.ts — add before writing any Rust
UPDATE_CHANNEL_POSITIONS: "update_hue_channel_positions",
// Status codes:
CHANNEL_POSITIONS_UPDATED: "HUE_CHANNEL_POSITIONS_UPDATED",
CHANNEL_POSITIONS_FAILED:  "HUE_CHANNEL_POSITIONS_FAILED",
```

---

### Pattern 2: Pure Derivation Function

**What:** Side-effect-free computation from one domain type to another. `zoneDerivation.ts` maps
`RoomMapConfig` to `LedCalibrationConfig` without touching stores or Tauri commands.

**When to use:** Any transformation between two persisted models. Keep it unit-testable in isolation.

**Trade-offs:** The output must be reviewed and explicitly saved by the user. No auto-apply —
this preserves user agency over calibration data that may be manually tuned.

---

### Pattern 3: Rust Runtime Cache + Slow-Path Fallback

**What:** The existing `get_hue_area_channels` command (line 1466 of `hue_stream_lifecycle.rs`)
checks the in-memory `HueRuntimeStateStore` first (fast, no I/O) and only calls the bridge if the
cache misses.

**When to use:** For `update_hue_channel_positions` — after a successful PUT, explicitly evict the
cached channels so the next `get_hue_area_channels` call reflects the new positions. Reuse the same
cache invalidation mechanism used by stream lifecycle.

**Trade-offs:** Cache can be stale if the bridge positions are changed outside the app. Acceptable
because positions change only via explicit user action.

---

## Data Flow

### Room Map → LED Zone Derivation → Calibration Save

```
User positions LED strip on RoomMapEditor
    |
    v
RoomMapConfig (local React state, dirty)
    |
    v  zoneDerivation.ts: deriveCalibrationFromRoomMap()
LedCalibrationConfig (suggested)
    |
    v  User reviews and confirms in CalibrationPage (existing "Save" button)
onCalibrationSaved()  [App.tsx, existing callback]
    |
    v
ShellState.ledCalibration  [plugin-store, existing key]
    |
    v
start_calibration_test_pattern OR lighting_mode  [Rust, existing commands]
```

### Hue Channel Position Edit → Bridge Write

```
User drags channel dot in HueChannelMapPanel (dirty local state)
    |
    v  "Save to bridge" button click
hueOnboardingApi.updateHueChannelPositions()  [new API function]
    |
    v  invoke("update_hue_channel_positions", ...)
Rust: hue_onboarding.rs  [new command]
    |
    v  PUT /clip/v2/resource/entertainment_configuration/{area_id}
Hue bridge stores new positions
    |
    v  Rust invalidates HueRuntimeStateStore channel cache
    v  Returns HUE_CHANNEL_POSITIONS_UPDATED
Frontend shows success state; re-fetches via get_hue_area_channels
```

### Hue Standalone Mode — Startup

```
ShellState.lastOutputTargets = ["hue"]  (no "usb")
    |
    v  App.tsx startup hydration
resolveHueRuntimePlan({ action: "start", selectedTargets: ["hue"] })
    |
    v  Route through canEnableHueStandaloneMode (not canEnableLedMode)
set_lighting_mode({ config: {...}, targets: ["hue"] })
    |
    v  Rust: targets does not include "usb" → skip serial port checks
    v  Route to start_hue_stream only; USB worker never spawned
HUE stream starts
```

---

## Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| `RoomMapEditor.tsx` | Drag/drop canvas, visual layout of light sources | `roomMapStore.ts` (state read/write) |
| `roomMapStore.ts` | React state + plugin-store persistence for `RoomMapConfig` | `shellStore.ts` (facade), `zoneDerivation.ts` (consumer) |
| `zoneDerivation.ts` | Pure: `RoomMapConfig → LedCalibrationConfig` | No external deps; consumed by RoomMapEditor "auto-derive" action |
| `HueChannelMapPanel.tsx` (extended) | Region override editing + xy position editing + bridge write | `hueOnboardingApi.ts` (write path), `getHueAreaChannels` (read path) |
| `modeGuard.ts` (extended) | LED mode guard (calibration) AND Hue standalone guard (hueConfigured) | Consumed by App.tsx mode change handler |
| `update_hue_channel_positions` (Rust, new) | PUT /clip/v2 channel positions to bridge | `HueRuntimeStateStore` (cache invalidation after write) |
| `lighting_mode.rs` (extended) | Route mode activation to correct output targets based on `targets` field | `HueRuntimeStateStore`, `SerialConnectionState` |
| `OutputTargetsPanel.tsx` (extended) | Target selection UI with standalone-aware guard | `usbConnected`, `hueConfigured` props (already present) |

---

## Build Order

Based on dependency analysis, the correct phase sequence is:

**Step 1 — Contracts (blocks everything else)**
- `src/shared/contracts/roomMap.ts` (new)
- Extend `shell.ts` with `roomMap?`, `roomMapVersion?`, `ROOM_MAP` section ID
- Extend `hue.ts` with `UPDATE_CHANNEL_POSITIONS` command and `CHANNEL_POSITIONS_*` status codes
- Run `yarn verify:shell-contracts` after each contract change

**Step 2 — Fault Recovery (unblocked, clears v1.1 debt)**
- HUE-08 Rust reconnect improvements + HDR-01/02 status codes and telemetry fields
- Depends only on existing contracts (all required status codes already in `hue.ts`)
- Clears debt before new features layer on top; standalone mode benefits from stable recovery

**Step 3 — Hue Channel Position Editor**
- Depends on: Step 1 (`UPDATE_CHANNEL_POSITIONS` command and status codes)
- `update_hue_channel_positions` Rust command in `hue_onboarding.rs`
- `hueOnboardingApi.ts` new function
- `HueChannelMapPanel.tsx` position edit mode + save-to-bridge button
- Can be built independently of room map; the panel already renders xy dots

**Step 4 — Room Map UI**
- Depends on: Step 1 (`roomMap.ts` contracts)
- `RoomMapEditor.tsx` + `LightSourceDot.tsx`
- `roomMapStore.ts` with plugin-store persistence
- New `ROOM_MAP` settings section in `SettingsLayout.tsx`
- No Rust changes in this step

**Step 5 — Hue Standalone Mode**
- Depends on: Step 2 (fault recovery must be stable before standalone is enabled)
- `modeGuard.ts` — add `canEnableHueStandaloneMode`
- `OutputTargetsPanel.tsx` — relax `isLastSelected` guard
- `lighting_mode.rs` — add `targets` field to `SetLightingModeRequest`
- Must come after Step 2 so standalone users inherit the improved HUE-08 recovery

**Step 6 — LED Zone Derivation**
- Depends on: Step 4 (RoomMapConfig with LED strip placement must exist)
- `zoneDerivation.ts` pure function (can be unit-tested in isolation first)
- Integration into RoomMapEditor "auto-derive zones" action
- Derived config passes through existing CalibrationPage + `onCalibrationSaved` path

**Step 7 — HUX-01/02 Device UX Polish**
- Depends on: Steps 2 and 5 (fault recovery and standalone mode must be stable)
- `DeviceSection.tsx` + `hueRuntimeStatusCard.ts` surface refinements
- Final integration polish before release gate

---

## Anti-Patterns

### Anti-Pattern 1: Auto-Applying Derived Calibration

**What people do:** Silently overwrite `ShellState.ledCalibration` when the user moves the LED
strip on the room map.

**Why it's wrong:** Zone derivation is geometric approximation. Silently replacing a manually-tuned
calibration destroys user work with no warning or recovery path.

**Do this instead:** Feed the derived config as `initialConfig` to the existing `CalibrationPage`.
The user explicitly saves via the existing "Save" button, triggering the test-pattern verification
flow before data is committed.

---

### Anti-Pattern 2: Persisting Bridge-Owned xy Coordinates Locally

**What people do:** Store Hue channel `positionX/positionY` values in `ShellState` as a cache.

**Why it's wrong:** The bridge is the source of truth. Local copies go stale silently. After a
partial-fail `update_hue_channel_positions`, the bridge and any local copy may diverge permanently.

**Do this instead:** Always fetch positions via `get_hue_area_channels` (which already uses the
Rust runtime cache as a fast path). Only hold dirty positions in transient React state during an
active edit session; discard on cancel, discard on successful bridge write (re-fetch replaces them).

---

### Anti-Pattern 3: Applying USB Guard to Hue Standalone Mode

**What people do:** Retain the `canEnableLedMode` (calibration required) gate when `outputTargets`
is `["hue"]` only.

**Why it's wrong:** LED calibration is not relevant when no USB device is in the target set.
Blocking mode enable with "calibration required" when the user has only configured Hue is
confusing and non-functional.

**Do this instead:** Route through `canEnableHueStandaloneMode` when `targets` does not include
`"usb"`. The two guards are independent and must not be mixed.

---

### Anti-Pattern 4: Adding `update_hue_channel_positions` to the Wrong Rust Module

**What people do:** Add the new command to `hue_stream_lifecycle.rs` because it is "Hue-related."

**Why it's wrong:** `hue_stream_lifecycle.rs` owns the DTLS streaming worker and `HueRuntimeStateStore`.
It is already the largest file in the codebase. Channel position write is a one-shot CLIP v2
configuration HTTP call — the same class of operation as `list_hue_entertainment_areas`.

**Do this instead:** Place `update_hue_channel_positions` in `hue_onboarding.rs`. It can call a
public cache-invalidation helper exported from `hue_stream_lifecycle.rs` without polluting the
lifecycle module.

---

## Integration Points

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `roomMapStore.ts` → `zoneDerivation.ts` | Direct function call (pure) | No state coupling; derivation is stateless |
| `zoneDerivation.ts` → `CalibrationPage` | Props: derived `LedCalibrationConfig` as `initialConfig` | Existing `CalibrationPage` prop — no interface change needed |
| `HueChannelMapPanel.tsx` → `hueOnboardingApi.ts` | `invoke()` via new function | New function only; existing region override path unchanged |
| `update_hue_channel_positions` (Rust) → `HueRuntimeStateStore` | Direct struct access within same binary | Cache invalidation: clear `active_stream.channels` after successful PUT |
| `lighting_mode.rs` → `HueRuntimeStateStore` | Existing `State<'_, HueRuntimeStateStore>` Tauri injection | `targets` extension on request struct; no state ownership change |
| `OutputTargetsPanel.tsx` → `modeGuard.ts` | Props already present (`usbConnected`, `hueConfigured`) | No new props; guard logic change is internal to `modeGuard.ts` and `App.tsx` |

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Hue CLIP v2 — `PUT /clip/v2/resource/entertainment_configuration/{area_id}` | New Rust HTTP in `hue_onboarding.rs` | Reuse existing `hue_http_client()` helper. Channel `z` coordinate should be `0.0` for 2D floor-plane placement. |
| plugin-store | Existing `shellStore.ts` facade | Add `roomMap`/`roomMapVersion` fields to `ShellState`; normalize via a `normalizeRoomMap()` function following the pattern in `calibration/model/contracts.ts` |

---

## Sources

- Direct codebase analysis: `src/shared/contracts/shell.ts` (ShellState shape, existing persistence keys)
- Direct codebase analysis: `src/shared/contracts/hue.ts` (HUE_COMMANDS, HUE_STATUS, HUE_RUNTIME_STATUS)
- Direct codebase analysis: `src/features/calibration/model/contracts.ts` (LedCalibrationConfig shape)
- Direct codebase analysis: `src/features/mode/state/modeGuard.ts` (canEnableLedMode guard logic)
- Direct codebase analysis: `src/features/mode/state/hueModeRuntimeFlow.ts` (resolveHueRuntimePlan)
- Direct codebase analysis: `src-tauri/src/commands/hue_onboarding.rs` (CLIP v2 HTTP patterns)
- Direct codebase analysis: `src-tauri/src/commands/hue_stream_lifecycle.rs` lines 80-200, 1440-1490 (HueRuntimeStateStore, get_hue_area_channels implementation)
- Direct codebase analysis: `src/features/settings/sections/HueChannelMapPanel.tsx` (existing xy rendering, region override UX)
- Direct codebase analysis: `src/features/settings/sections/control/OutputTargetsPanel.tsx` (isLastSelected guard, usbConnected/hueConfigured props)
- Direct codebase analysis: `src/features/device/hueOnboardingApi.ts` (invoke bridge pattern)
- Philips Hue CLIP v2 API reference: `entertainment_configuration` resource supports PUT with `channels[].position.x/y/z`

---
*Architecture research for: LumaSync v1.2 Room Visualization and Universal Light Management*
*Researched: 2026-03-30*
