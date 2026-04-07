---
phase: 19-led-zone-auto-derivation
plan: "03"
subsystem: ui
tags: [react, typescript, zone-management, hue-channel, tailwind, room-map]

requires:
  - phase: 19-01
    provides: deriveZones() pure function and ZoneDeriveResult/DerivedSegment types
  - phase: 19-02
    provides: ZoneDeriveOverlay, extended RoomMapToolbar with onAddZone/onDeriveZones props

provides:
  - ZoneListPanel component with 6-color rotation, max-h-[160px], inline rename, delete, active highlight
  - Extended HueChannelOverlay with zoneAssignMode, activeZoneColor ring, opacity-50 for unassigned channels
  - Zone CRUD state management in RoomMapEditor (handleAddZone, handleDeleteZone, handleRenameZone, handleSelectZone, handleChannelZoneToggle)
  - ZoneListPanel rendered below canvas, shown when zones exist or panel is open
  - roomMap.zones i18n keys in EN and TR locales (panelTitle, addZoneButton, defaultName, emptyPanel, deleteAriaLabel, lightCount, lightCountOne, + derive keys)

affects:
  - 19-04 (zone persistence and ROOM-03 full completion depends on this wiring)

tech-stack:
  added: []
  patterns:
    - "ZoneListPanel: 6-color ZONE_COLORS rotation with getZoneColor(index) exported helper"
    - "HueChannelOverlay: onChannelZoneToggleRef useRef pattern prevents stale closure (Pitfall 5)"
    - "RoomMapEditor: ZONE_COLOR_HEX parallel array for CSS boxShadow inline ring (Tailwind classes cannot be used for dynamic colors)"
    - "ZoneListPanel.test.tsx: @vitest-environment node with async import() tests (jsdom ESM incompatibility in Node v25)"

key-files:
  created:
    - src/features/settings/sections/room-map/ZoneListPanel.tsx
    - src/features/settings/sections/room-map/ZoneListPanel.test.tsx
  modified:
    - src/features/settings/sections/room-map/HueChannelOverlay.tsx
    - src/features/settings/sections/RoomMapEditor.tsx
    - src/locales/en/common.json
    - src/locales/tr/common.json

key-decisions:
  - "ZoneListPanel uses @vitest-environment node with module-level import() tests — DOM render tests blocked by jsdom v29/@asamuzakjp/css-color ESM incompatibility (same constraint as ZoneDeriveOverlay)"
  - "ZONE_COLOR_HEX parallel array in RoomMapEditor provides hex values for inline boxShadow ring — Tailwind bg-* classes cannot be used for dynamic CSS color values"
  - "RoomMapToolbar/ZoneDeriveOverlay/deriveZones brought forward from Plan 01/02 commits — worktree was on 18-02 base and lacked these files; applied as deviation Rule 3 (blocking issue)"

metrics:
  duration: ~20 minutes
  completed: "2026-04-07"
  tasks_completed: 2
  files_created: 2
  files_modified: 4

requirements-completed:
  - ROOM-03
---

# Phase 19 Plan 03: Named Zone Definition Panel and Channel Assignment Summary

Named zone panel with color chips, inline rename, delete, and Hue channel assignment mode implemented via ZoneListPanel and extended HueChannelOverlay.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create ZoneListPanel component | 4a3d400 | ZoneListPanel.tsx, en/tr common.json |
| 2 | Extend HueChannelOverlay with zone assign mode, wire RoomMapEditor | bb67756 | HueChannelOverlay.tsx, RoomMapEditor.tsx, ZoneListPanel.test.tsx, + Plan 01/02 forward-ported files |

## What Was Built

**ZoneListPanel** (`src/features/settings/sections/room-map/ZoneListPanel.tsx`):
- 6-color rotation: `bg-blue-500`, `bg-emerald-500`, `bg-purple-500`, `bg-amber-500`, `bg-rose-500`, `bg-cyan-500`
- `max-h-[160px] overflow-y-auto` prevents canvas collapse in 900x620 window
- Inline rename on double-click: transparent border-b input, commits on Enter or blur
- Delete button with `aria-label` per UI-SPEC
- Active zone row highlight: `bg-slate-100 dark:bg-zinc-800 rounded`
- Empty state: `t("roomMap.zones.emptyPanel")`
- Exports: `ZoneListPanel`, `getZoneColor`, `ZONE_COLORS`

**HueChannelOverlay extensions** (`src/features/settings/sections/room-map/HueChannelOverlay.tsx`):
- `zoneAssignMode?: boolean` — when true, clicks call `onChannelZoneToggle` instead of `onSelect`
- `activeZoneColor?: string | null` — hex color for 2px boxShadow ring on active-zone dots
- `assignedChannels?: Set<number>` — channels in any zone
- `activeZoneChannels?: Set<number>` — channels in the currently selected zone
- `onChannelZoneToggle?: (channelIndex: number) => void` — toggle zone membership
- `onChannelZoneToggleRef` useRef pattern prevents stale closure
- Unassigned channels render `opacity-50` in zone assign mode
- `aria-pressed` reflects zone membership in assign mode

**RoomMapEditor zone management** (`src/features/settings/sections/RoomMapEditor.tsx`):
- `activeZoneId` and `zonePanelOpen` state
- `handleAddZone` — creates UUID zone, calls `updateConfig({ zones: [...] })`, opens panel
- `handleDeleteZone` — filters zone list, clears activeZoneId if deleted
- `handleRenameZone` — maps over zones to update name
- `handleSelectZone` — simple setter
- `handleChannelZoneToggle` — toggle channel index in active zone's channelIndices
- `ZONE_COLOR_HEX` + `getZoneColorHex` for dynamic CSS ring color
- Derived: `zoneAssignMode`, `activeZone`, `activeZoneIndex`, `assignedChannels`, `activeZoneChannels`
- `ZoneListPanel` rendered after canvas div, shown when `zonePanelOpen || config.zones.length > 0`
- `onAddZone={handleAddZone}` wired in RoomMapToolbar (replaces Plan 02 stub)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Plan 01/02 files absent from worktree**
- **Found during:** Task 2 — typecheck revealed missing ZoneDeriveOverlay, deriveZones, and RoomMapToolbar was missing onAddZone/onDeriveZones props
- **Issue:** This worktree was based on 18-02 commit; 19-01 and 19-02 commits existed only on the main branch
- **Fix:** Cherry-picked files from main branch via `git show main:...` — RoomMapToolbar.tsx, ZoneDeriveOverlay.tsx, ZoneDeriveOverlay.test.tsx, deriveZones.ts, deriveZones.test.ts
- **Files modified:** 5 files brought forward
- **Commit:** bb67756 (included in Task 2 commit)

**2. [Rule 2 - Missing critical functionality] Added panelTitle i18n key**
- **Found during:** Task 1
- **Issue:** Plan spec referenced section header title but had no i18n key for it
- **Fix:** Added `roomMap.zones.panelTitle` to EN and TR locales ("Zones" / "Bölgeler")
- **Files modified:** src/locales/en/common.json, src/locales/tr/common.json

## Known Stubs

None. Zone definitions persist through `useRoomMapPersist` via `updateConfig({ zones })`. Panel renders when zones exist or when `+ Zone` is clicked.

## Self-Check: PASSED

Files created/modified:
- [x] src/features/settings/sections/room-map/ZoneListPanel.tsx — FOUND
- [x] src/features/settings/sections/room-map/ZoneListPanel.test.tsx — FOUND
- [x] src/features/settings/sections/room-map/HueChannelOverlay.tsx — FOUND
- [x] src/features/settings/sections/RoomMapEditor.tsx — FOUND

Commits:
- [x] 4a3d400 — feat(19-03): create ZoneListPanel — FOUND
- [x] bb67756 — feat(19-03): extend HueChannelOverlay — FOUND

Tests: 27 passing (deriveZones: 13, ZoneDeriveOverlay: 7, ZoneListPanel: 7)
TypeScript: clean (yarn typecheck exits 0)
