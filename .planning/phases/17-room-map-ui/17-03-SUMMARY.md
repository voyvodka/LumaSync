---
phase: 17-room-map-ui
plan: "03"
subsystem: room-map
tags: [room-map, drag-drop, resize, furniture, tv-anchor, usb-strip, pointer-capture]
dependency_graph:
  requires: [17-02]
  provides: [FurnitureObject, TvAnchorObject, UsbStripObject, wired-canvas-objects]
  affects: [RoomMapEditor, RoomMapCanvas]
tech_stack:
  added: []
  patterns:
    - pointer-capture drag (setPointerCapture)
    - local state mirroring for drag smoothness
    - ResizeObserver for pxPerMeter computation
key_files:
  created:
    - src/features/settings/sections/room-map/FurnitureObject.tsx
    - src/features/settings/sections/room-map/TvAnchorObject.tsx
    - src/features/settings/sections/room-map/UsbStripObject.tsx
  modified:
    - src/features/settings/sections/RoomMapEditor.tsx
decisions:
  - FurnitureObject hides resize handles when rotation != 0 to avoid transform-space conflict
  - pxPerMeter owned by RoomMapEditor via ResizeObserver on canvas container ref; passed as prop
  - UsbStripObject uses DOM divs (not SVG) for drag handles to retain pointer-events
  - handleDelete strips object-type prefix (furniture-/usb-/hue-) before filtering arrays
metrics:
  duration: ~20min
  completed_date: "2026-04-06"
  tasks_completed: 2
  files_changed: 4
---

# Phase 17 Plan 03: Draggable Room Map Objects Summary

**One-liner:** Three interactive canvas objects (FurnitureObject, TvAnchorObject, UsbStripObject) with pointer-capture drag, resize, rotation, and snap-to-grid — wired into RoomMapEditor render tree.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | FurnitureObject + TvAnchorObject | 53f2ec8 | FurnitureObject.tsx, TvAnchorObject.tsx |
| 2 | UsbStripObject + RoomMapEditor wiring | 058c97e | UsbStripObject.tsx, RoomMapEditor.tsx |

## What Was Built

### FurnitureObject.tsx
- Draggable div using pointer capture (`setPointerCapture`) pattern
- Type-based color palette: sofa (slate), table (amber), chair (emerald), other (violet)
- 4-corner resize via ResizeHandle components (hidden when rotation != 0)
- Minimum size enforcement: `24 / pxPerMeter` meters
- Snap-to-grid on pointer up when `snapEnabled` is true
- Selection outline: `outline-2 outline-offset-2 outline-slate-900 dark:outline-zinc-100`
- CSS `transform: rotate(${rotation}deg)` applied inline

### TvAnchorObject.tsx
- Same drag + resize pattern as FurnitureObject
- Violet styling: `bg-violet-500/40 border-2 border-violet-500`
- "TV" label in `text-violet-700 dark:text-violet-300`
- Always shows resize handles when selected (no rotation field on TvAnchorPlacement)

### UsbStripObject.tsx
- SVG overlay (`pointer-events: none`) renders dashed cyan line (`stroke="#06b6d4" strokeDasharray="4 4"`)
- Arrow polygon at end point rotated to match line angle
- Two DOM handle divs with pointer capture drag for independent start/end positioning
- LED count `<input type="number">` shown at line midpoint when selected
- `onChange` called on pointer up with updated positions

### RoomMapEditor.tsx updates
- Added `useRef` + `ResizeObserver` to compute `pxPerMeter` and `gridStepPx` from canvas container
- Imports and renders all three object components inside `<RoomMapCanvas>` children block
- `handleDelete` correctly strips `furniture-`, `usb-`, `hue-` prefixes before filtering
- `handleRotate` strips `furniture-` prefix before finding item to rotate
- Object selection uses namespaced IDs: `furniture-{id}`, `usb-{stripId}`, `tv`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Unused parameter `e` in FurnitureObject resize drag start**
- **Found during:** Task 2 — `yarn typecheck` run
- **Issue:** `handleResizeDragStart` received `e: React.PointerEvent` but never used it; TS6133 error
- **Fix:** Renamed to `_e` to signal intentional non-use
- **Files modified:** FurnitureObject.tsx
- **Commit:** 058c97e (included in Task 2 commit)

## Known Stubs

None — all object types render real data from `config` and persist via `onChange` → `updateConfig` → `useRoomMapPersist`.

## Self-Check: PASSED

- [x] FurnitureObject.tsx exists and exports `FurnitureObject`
- [x] TvAnchorObject.tsx exists and exports `TvAnchorObject`
- [x] UsbStripObject.tsx exists and exports `UsbStripObject`
- [x] RoomMapEditor.tsx imports all three object components
- [x] `yarn typecheck` passes with zero errors
- [x] Commits 53f2ec8 and 058c97e exist
