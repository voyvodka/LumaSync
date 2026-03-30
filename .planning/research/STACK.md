# Stack Research

**Domain:** Tauri 2 + React 19 desktop app — 2D room map editor, Hue channel position editing, LED zone auto-derivation, Hue standalone mode (LumaSync v1.2 additions)
**Researched:** 2026-03-30
**Confidence:** MEDIUM-HIGH

> **Scope note:** This document covers only NEW stack additions for v1.2. The validated base stack (Tauri 2, React 19, Vite 8, TypeScript 6, Tailwind CSS 4, i18next, plugin-store, reqwest, serialport, tauri-plugin-log) is documented in the v1.0 research file and is not repeated here.

---

## Recommended Stack — New Additions Only

### Core Technologies

| Technology | Version | Purpose | Why Recommended | Confidence |
|------------|---------|---------|-----------------|------------|
| react-konva | ^19.2.3 | 2D interactive room map canvas — drag/drop light sources, draw zones | Version-aligned to React 19 (peerDep: react ^19.2.0). Canvas rendering avoids DOM overhead for many draggable objects. Stage→Layer→Shape hierarchy maps directly to Room→Zones→LightSources. No server deps — pure browser canvas, works correctly in Tauri/Vite without SSR. Native drag-and-drop, hit detection, and Transformer handles included. | MEDIUM |
| konva | ^10.2.3 | Underlying canvas engine required by react-konva | Peer dependency — must be installed alongside react-konva. Provides the 2D rendering engine: shapes, animations, events, drag logic, hit detection. Version 10.x is the current stable series. | MEDIUM |
| zustand | ^5.0.12 | In-memory room map state store during editing session | Lightweight (< 2 KB gzip). React 19 compatible (requires React >= 18 — React 19 satisfies this). Flat store model suits the room map's serializable shape: a unified object that updates cohesively when a light is moved. Does NOT replace plugin-store — sits in memory, flushed to plugin-store on save events. | HIGH |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @tauri-apps/plugin-store | ^2.4.2 (existing) | Room map persistence to disk across sessions | Extend existing `ShellState` interface in `src/shared/contracts/shell.ts` with a `roomMap?: RoomMapState` field. No new library — reuse the established `shellStore.ts` facade pattern. |
| (no geometry library) | n/a | Coordinate transform: room x/z position → screen edge assignment | The LED zone derivation algorithm needs only bounding-box classification (is this point closest to left/right/top/bottom edge of a rectangle). Approximately 40-60 lines of pure TypeScript. Adding a geometry library for this specific problem is over-engineering. Write `src/features/room/model/roomToScreenEdge.ts` as a pure utility. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| vitest (existing) | Unit tests for coordinate transform utilities | `roomToScreenEdge.ts` should have deterministic test coverage — incorrect zone derivation silently breaks Ambilight output without any visible error. Follow existing test patterns in `src/features/`. |

---

## Installation

```bash
# New canvas dependencies
yarn add react-konva konva

# In-memory state management for room map
yarn add zustand
```

No new Rust crates are needed. All Hue channel position reads and writes go through the existing `reqwest` HTTP client in the Rust command layer, following the pattern already established in `hue_onboarding.rs` and `hue_stream_lifecycle.rs`.

---

## Hue CLIP v2: Existing HTTP Client is Sufficient

No new HTTP library or Tauri plugin is needed for Hue channel position editing.

**What the API supports (MEDIUM confidence — inferred from aiohue Python model + HyperHDR discussion; the official PUT schema requires meethue.com developer registration to verify completely):**

The `entertainment_configuration` resource exposes channels with 3D spatial coordinates:

```json
{
  "channel_id": 0,
  "position": { "x": -0.21547, "y": 1.0, "z": -1.0 },
  "members": [{ "service": { "rid": "...", "rtype": "entertainment" }, "index": 0 }]
}
```

Coordinate space: x and z define the horizontal plane (range −1 to +1, center at 0,0). y is the vertical axis (−1 = floor, +1 = ceiling). For a 2D top-down room map, x and z are the working axes; y can be left unchanged or set to a fixed value per channel type (lights typically at 0, LED strips at −1).

`PUT /clip/v2/resource/entertainment_configuration/{id}` accepts position updates in the same channels structure. The `action` field (`start`/`stop`) is orthogonal to position edits on the same endpoint.

**Implementation approach:**
- Add `hue_channel_positions.rs` command module alongside existing Hue commands.
- `GET_AREA_CHANNELS` command: already declared in `src/shared/contracts/hue.ts` — implement the Rust handler to return channels with positions.
- `UPDATE_CHANNEL_POSITIONS` command: new — accepts a channel-id-to-xyz map, constructs the PUT body, sends to bridge, returns a `CommandStatus`.
- Frontend shows positions read from bridge on initial load; saves back only on explicit user action ("Save to Bridge" button) to avoid accidental bridge state mutation during map editing.

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| react-konva + konva | React Flow (xyflow) | React Flow is designed for connected node-graph editors (flowcharts, pipelines). Room maps need free canvas placement without edge/node semantics. Konva is the correct abstraction for a free-placement editor. |
| react-konva + konva | Fabric.js | Fabric is heavier, has no first-class React 19 bindings, and its last major version dates to 2023. Konva explicitly aligns versions with React major releases. |
| react-konva + konva | D3.js | D3 is SVG-based and imperative. Mixing D3 DOM mutations with React's reconciler is a well-documented source of bugs. Avoid mixing rendering models. |
| react-konva + konva | Custom canvas with useRef | Valid for simple one-off drawings. For a room map with drag-and-drop, multi-object selection, transformer handles, and hit detection, raw canvas would require rebuilding what Konva already provides. |
| zustand | jotai | Jotai excels at fine-grained atomic reactivity for independent state slices. Room map state updates as a cohesive unit — moving a light triggers a zone recomputation across the whole map. Zustand's store model handles this more naturally. |
| zustand | React Context | Context triggers full subtree re-renders on every state change. Unacceptable for a canvas editor where drag events fire at 60 Hz. |
| zustand | Redux Toolkit | Excessive boilerplate for a focused room map store with 4-6 actions. Zustand is idiomatic for this scope. |
| Inline coordinate math utility | flatten-js / ts-2d-geometry | The zone derivation algorithm is bounding-box classification, not complex geometry. No polygon operations, intersection tests, or affine matrix chains are required. A single utility function eliminates a dependency entirely. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Three.js / react-three-fiber | PROJECT.md v1.2 mentions "3D/2D" room map but the actual requirements are 2D top-down floor plans for LED zone assignment. 3D adds enormous bundle size (> 600 KB) and UX complexity with zero user value. | react-konva for 2D |
| @tauri-store/zustand | Third-party Tauri plugin that syncs Zustand to disk. Introduces a Rust crate dependency and deviates from the established `shellStore.ts` + plugin-store facade already in production. | zustand (in-memory) + existing `@tauri-apps/plugin-store` via `shellStore.ts` |
| react-dnd / dnd-kit | General-purpose DOM drag-and-drop libraries. Konva provides its own drag-and-drop system for canvas objects via the `draggable` prop. Two competing event systems on the same canvas will conflict. | Konva's native `draggable` + `onDragMove`/`onDragEnd` events |
| Fabric.js | React 19 bindings are community-maintained and lag behind. Last major version in 2023. | react-konva + konva |

---

## Stack Patterns by Variant

**If the room map editor needs a background floor plan image:**
- Add `yarn add use-image` (lightweight, ~1 KB) for loading images into a Konva Layer.
- Render the floor plan as a `Konva.Image` in a locked background Layer; place light source objects in a separate interactive Layer on top.

**If channel position write-back to Hue bridge should be optional:**
- Store canonical room map positions in `ShellState.roomMap` (plugin-store). The Konva editor works against this local state.
- Only call `UPDATE_CHANNEL_POSITIONS` when the user explicitly triggers "Save to Bridge".
- This prevents accidental bridge state mutations while the user is still exploring layout options.

**If LED zone auto-derivation must support multiple monitors:**
- The `roomToScreenEdge` utility should accept `displayBounds[]` (from the existing `list_displays` command in `calibration.rs`).
- Each display has its own screen-edge coordinate space. Room positions are projected into the nearest display's edge frame.

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| react-konva@^19.2.3 | react@^19.2.0, konva@^10.x | The 19.x version line of react-konva ONLY supports React 19. Do NOT use react-konva@18.x with React 19 — it will emit peer dependency errors and may behave incorrectly. |
| konva@^10.2.3 | react-konva@19.x | Must install alongside react-konva; both are listed as explicit dependencies (not just peer). |
| zustand@^5.0.12 | react@>=18 | Zustand v5 made React 18 the minimum version; React 19 is within range. Breaking change from v4 — do not install v4. |
| @tauri-apps/plugin-store@^2.4.2 | Tauri 2.x (existing) | No change to plugin-store. RoomMapState is an extension of the existing ShellState interface, added as an optional field. |

---

## Sources

- [react-konva npm](https://www.npmjs.com/package/react-konva) — version 19.2.3, peerDep react ^19.2.0 confirmed (MEDIUM — npm listing, not Context7)
- [konvajs/react-konva GitHub](https://github.com/konvajs/react-konva) — React 19 version alignment, no SSR requirement (MEDIUM)
- [konva npm](https://www.npmjs.com/package/konva) — version 10.2.3 current (MEDIUM)
- [Konva.js FAQ](https://konvajs.org/docs/faq.html) — client-only rendering, Tauri/desktop compatible (MEDIUM)
- [zustand GitHub](https://github.com/pmndrs/zustand) — version 5.0.12, React 19 compatible (HIGH — official repo)
- [zustand React 19 discussion](https://github.com/pmndrs/zustand/discussions/2842) — explicit React 19 compatibility confirmation (HIGH)
- [aiohue entertainment_configuration.py](https://github.com/home-assistant-libs/aiohue/blob/main/aiohue/v2/models/entertainment_configuration.py) — channel/position model structure (MEDIUM — open-source reference implementation)
- [HyperHDR Hue config discussion](https://github.com/awawa-dev/HyperHDR/discussions/512) — xyz coordinate JSON example: `{"x": -0.21547, "y": 1, "z": -1}` (MEDIUM)
- [openhue/openhue-api](https://github.com/openhue/openhue-api) — comprehensive OpenAPI spec for CLIP v2 exists; PUT body schema for positions not extracted (requires YAML inspection) (LOW-MEDIUM)
- [Philips Hue Entertainment API overview](https://iotech.blog/posts/philips-hue-entertainment-api/) — endpoint and authentication pattern confirmed (MEDIUM)

---

*Stack research for: LumaSync v1.2 — Room Visualization and Universal Light Management*
*Researched: 2026-03-30*
