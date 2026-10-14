# Room map

A top-down editor for where the lights physically are: the room footprint, the TV, furniture, USB
strip runs, and Hue channel dots. Most users never open it — first run reaches working ambient
lighting without it — but everything authored here feeds the runtime sampler, so the coordinate
rules below are load-bearing rather than cosmetic.

The module is `src/features/room-map/`. Its entry point is `RoomMapSurface.tsx`: the room in 3D
(View, where the build carries it) and the plan (Edit, `RoomMapEditor.tsx`, one of the largest
single pieces of UI in the codebase) over one slot.

## Decisions

**A channel bound to a Hue zone stores its position relative to that zone, never in world
coordinates.** `zoneRelativePosition` is the persisted truth and the absolute `x`/`y` on the
channel is a stale leftover from before zones existed. Every path that reads a position — the
render, the drag clamp, and the write-back — resolves the parent zone first and projects through
it, and every one of them resolves the zone from the full zone list rather than from the active
selection. An earlier version only enforced the binding while the zone was selected, so selecting
a different zone let its dots drift out of their parent's box and the next save wrote coordinates
that no longer round-tripped. If you touch one of the three, check the other two: they have to
agree on which zone a channel belongs to or the contract breaks on save, not on screen.

**Editing is local-first and optimistic; the Tauri call mirrors, it does not confirm.** Every zone
and channel handler mutates the local `RoomMapConfig` and then fires its command. The local config
is the persistence source of truth — the Rust side keeps its own copy only so the runtime sampler
can see the change. A failed invoke is logged, never swallowed, but the local edit stands: reverting
it would flicker the canvas, and the next save round reconciles. That is why a handler that returns
early on an invoke failure is wrong here even though it would be right elsewhere.

**The map belongs to the surface, not to a face.** `useRoomMapDocument` — the config, history,
selection and save queue, the Hue area the map is bound to, and the bridge's channel seeding — runs
in `RoomMapSurface`, and each face reads it as a prop. So a switch between View and Edit keeps undo,
the selection and a gesture still waiting to save, and the channels are seeded whichever face is
open. The face left behind unmounts: the plan does not keep rendering, or taking keys, under the
room, and the room hands its WebGL context back under the plan. The one thing a switch drops is the
plan's zoom and pan, which fit the room again on return. The View | Edit switch is the surface's
own, floating over both faces' top bars, so a keyboard switch keeps focus on it. The face is not
stored: the map always opens on the room, and an empty map with no history opens on the templates
before either face.

**Every typed number is one field, and the inspector holds them all.** `ui/DecimalField.tsx` is
the room map's only number input: the inspectors' position, size, height and rotation, a strip's
LED count, a zone's edge and the room's size. It reads as a value at rest, applies on leaving or
Enter, takes a comma as the decimal mark (Turkish writes one), and puts the old value back for a
number out of range, as Esc does — the design language's rule, where the fields it replaced had
clamped. ↑/↓ step and apply at once, so a caller that saves per commit passes a gesture key: typed
moves go through the adapter's `moveTo` under `move:<id>`, which also writes a zone-bound Hue
channel's live field. A field shows the map's metres whatever the kind stores: a Hue channel's cube
position through `hueToPlanMetres`/`planMetresToHue`, an image's canvas pixels divided by
`ROOM_MAP_PX_PER_METER`. The row of numbers under the plan that once held some of these is gone.

**The editor's config, undo history and selection are one reducer, and a gesture reaches it once.**
`state/roomMapReducer.ts` holds all three; `useRoomMapState` drives it and owns saving. Its actions
are `apply` (a user edit: one undo entry, one save), `adopt` (a write the user did not make — the
bridge seed, a refused Hue zone mutation's pre-image — which saves but stays out of history, or
Cmd+Z would restore what the backend refused), `undo`/`redo`, and the two selections. An `apply`
may carry a gesture key: consecutive applies under the same key within `GESTURE_COALESCE_MS`, or
flagged as a key auto-repeat, fold into one undo step, and their save waits until the gesture goes
quiet (leaving the room map flushes it; a face switch need not, as the map outlives the face). Arrow nudges, the Hue zone size slider and colour picker, the channel
height slider, the image opacity slider and wheel, and the on-canvas LED count use it. A pointer
drag does not need it: every canvas object keeps its in-flight position in local state or the DOM
and calls back once, on release. Undo can remove the selected object, so the reducer drops a
selection that no longer resolves. History is snapshots, so undoing past an `adopt` also takes the
adopted change back; the adopts that exist are rare and re-run on the next bridge read.

**A pan moves one transform; the objects never render for it.** The canvas writes the object
layer's `transform` straight to the DOM on every pointer move and commits the offset on release.
The canvas objects are `memo` components and the editor hands them only stable callbacks, so that
one commit re-renders none of them either. An inline closure in their props undoes this silently —
`RoomMapEditor.pan.test.tsx` counts their renders. The grid is drawn a canvas-width past the view
on each side, so the part a pan reveals before it commits is already there. Snap guides live in the
editor, so `useSnapGuides` stores a new list only when it differs from the last one.

**Channel-to-zone assignment keeps three shapes in sync by hand.** One handler serves drag-drop onto
a zone header, drag-drop onto the unassigned bucket, and the "Move to →" popover, because all three
have to write the same three fields: the channel's `zoneId` (the join key), its
`zoneRelativePosition` (reset to the zone centre, refined by dragging), and the zone's
`channelIndices` (denormalised for the runtime sampler). Letting those drift desyncs the frame
builder from the zone-cap validator.

**Hue channels are bridge-managed; the editor never deletes one.** Only the Hue app or the bridge
can remove a channel from an entertainment configuration, so LumaSync has no delete affordance for
them. An earlier build spliced them out of `config.hueChannels` by array index, which detached the
channel from its zone in a way the user had not asked for *and* shifted every later channel's slot.
Detaching goes through "Move to → Unassigned" instead. Anything reaching for a channel by array
position rather than `channelIndex` is repeating that bug.

**LED Setup owns the strip's edge counts; the map does not propose them.** The map once measured a
strip against the TV and handed per-edge counts to LED Setup as a draft ("LED counts from the map").
It was removed with the canvas-first LED Setup: two places that could set the same counts meant the
user had to reconcile them, and a strip drawn by eye on a room plan is a worse measurement than the
number printed on the strip. A strip's `ledCount` on the map follows LED Setup's save
(`syncStripLedCount`), never the other way.

**The editor never mints a Hue channel, and every consumer addresses one by the bridge's
`channelId`.** An "Add Hue channel" button once stamped a local `channelIndex` — by array length,
which on a gapped map duplicated a live index — for a marker matching nothing on the bridge. It is
gone: channels enter `hueChannels` only by seeding from the bridge's own list
(`seedChannelPlacements` in `model/hueChannelSeeding.ts`, shared by the room map and the Devices
panel so the two cannot disagree about which channel is which). `resolveChannelPlacement` there is
the one place a placement meets its live channel, so it stamps `channelId`; the stream start and
room-aware sampling (`toChannelPlacements` → `apply_channel_placements`) and the write-back
(`merge_service_locations`) all match on it and skip a record without one. Which light gets which
colour still comes from the bridge's channel array (`flatten_light_slots` in
`commands/hue/sender/http_fallback.rs`), so a bad placement can move a real channel's sampled region or its
bridge position, never re-route a light.

**The Devices channel map writes the same `hueChannels` the room map does, so it has to carry the whole record rather than flatten it.** It no longer edits positions — placement is authored here — but it still seeds, pushes and takes the bridge's arrangement. Its rebuild once emitted a bare `{channelIndex, x, y, z}` literal, dropping `label`, `locked`, `zoneId` and `zoneRelativePosition` on every save: a zone-bound channel came back detached, and with no area attribution a second entertainment area's placements overwrote the first's. `resolveChannelPlacement` returns the stored record with its world position resolved through the zone, and every position write (drag, nudge, the height inspector, "Take bridge's") goes through `model/hueChannelPosition.ts` so a bound channel's `zoneRelativePosition` moves with it — writing only the absolute pair would leave the runtime resolving the old position. Height has its own helper (`setHueChannelWorldZ`) because Rust resolves `center_z + scale_z * relative.z` too.

**A channel's height carries its provenance, because a stored `z = 0` does not say whether anyone measured it.** Until heights were carried end to end, seeding wrote `z: 0` for every new channel whatever the bridge reported, so a stored `0` is as likely a placeholder as a measurement. `zOrigin` (`"bridge"` | `"user"`, absent ⇒ unknown) settles it without a migration or a schema bump, since an absent field already means "unknown". A new record takes the bridge's `z` stamped `"bridge"`, or `0` with no origin when the bridge reports none. A legacy record with no origin and `z === 0`, not bound to a zone, is a seeding placeholder: it adopts the bridge's height when there is one. A legacy non-zero `z` was authored locally — the height slider, or a zone the channel has since left — so it is stamped `"user"`, and every later slider write (`setHueChannelWorldZ`) stamps `"user"` too. A zone-bound legacy record is left alone — its height is the zone's projection, not a seeded default, and adopting the bridge's would quietly detach it. The start request (`toChannelPlacements`) honours an unknown origin rather than trusting the number: it omits `positionZ`, so the stream keeps the bridge's own height. The bridge write-back consults it the same way: a height of unknown origin keeps the bridge's own `z` instead of writing the placeholder (`merge_service_locations` in `room_map/save_load.rs`; the write path itself is in `hue.md`). The bridge-sync state (`hueSyncState.ts`) does: a recorded arrangement carries `positionZ` only for a height of known origin (or, for a read of the bridge, only when the bridge reported one), and height counts toward "in sync" only when both sides carry one — a snapshot written before heights were recorded compares `x`/`y` alone, so an upgrade does not turn every area "not saved to bridge". "Take bridge's" adopts the bridge's height with `zOrigin: "bridge"` through `setHueChannelWorldZ`, so a zone-bound channel's relative height moves with it (`adoptBridgePlacement` in `hueChannelSeeding.ts`); how the verdict is reached is in `hue.md`. The persisted `z` stays a plain `number`. Only room-aware sampling reads it (below), and only while a TV anchor exists; without one, region, topology and screen affinity still read `x`/`y` alone, so for that user carrying it changes no colour.

**Room-aware sampling is gated on the TV anchor, and distance never excludes a light.** When the room map has a TV, the mode payload carries a `roomGeometry` projection — room dimensions, the TV footprint, and the Hue placements again — and the ambilight worker samples each Hue channel by where it stands relative to the screen (`commands/room_affinity.rs`); without a TV the field is absent and the worker runs exactly the legacy path. The Hue cube maps onto room metres as `x_m = (x+1)/2·W`, `y_m = (1−y)/2·D`, `z_m = (z+1)/2·H`. Horizontal sampling is the light's offset from the TV centre in half-TV-widths, clamped, so a lamp well to the left of the screen samples its left edge rather than a point off the frame. Vertical comes from **height**, piecewise: floor → bottom row, TV mount height → centre, ceiling → top row. Depth no longer stands in for vertical, which is what the legacy path does and is wrong for a floor lamp beside the TV; an unknown height (`positionZ` absent) samples at mount height rather than letting depth decide. The mount height defaults to 40% of the room height (`DEFAULT_TV_MOUNT_HEIGHT_FRACTION`), resolved at runtime rather than written so it follows a room-height edit. Distance from the screen centre — 3-D, normalised by the farthest room corner — only sets the ambience blend (`screen_affinity`) and never the sample window's size, and no light is ever dropped. Affinity runs from `1` at the screen centre down to `ROOM_AFFINITY_FLOOR` (0.25) at the farthest corner, linearly in distance, rather than to `0`: the scene stage blends `b = 1 − aff·(1 − lean)`, so at `0` a far light took the frame-wide ambience alone and lost its side of the picture, and every lamp at the back of the room showed the same colour. The floor keeps at least a quarter of the light's own region wherever the frame is structured enough to keep regions at all (`lean < 1`). The legacy path (`hue_default_screen_affinity`, no TV anchor) has no floor and is unchanged. Geometry that fails validation (non-positive room, TV outside it, a mount above the ceiling, a non-finite placement) is logged as `[room-geometry] rejected — <reason>` and the worker keeps the legacy table; it is never a refused mode change and has no status code. Every room template except Empty places a TV, so a user who picked one becomes room-aware on the upgrade that brought the gate; `RoomAwareIndicator` is how they can tell. Sampling stays relative to the TV rather than to a viewer: a viewer anchor was considered and dropped, and `RoomGeometry` can take an optional one later without breaking the shape.

**A drag reaches the running worker through a cell, not a restart.** `roomGeometry` is deliberately left out of the `apply_mode_change` fast-path equality list. The fast path writes it into `RoomGeometryLive` and bumps a generation counter; the worker reads that counter once per frame and rebuilds its per-channel table only when it moved, overlaying `huePlacements` onto the stream's channels by `channel_id` with the same `apply_channel_placements` the stream start uses. The placements travel twice because the stream's copy is fixed at stream start — restarting the Hue stream per drag commit is exactly the teardown this avoids. See `capture-and-pipeline.md` for the fast-path rule it is an exception to.

**The geometry is projected when the mode is applied, and never stored.** Rust projects it from the saved `roomMap` and `lastHueAreaId` each time the lighting transaction applies an Ambilight mode (`room_geometry_from_state` in `commands/hue/hue_config.rs`, a port of `toRoomGeometry`; one JSON fixture keeps the two in parity). `normalizeLightingModeConfig` still drops the field, so a persisted `lightingMode` can never carry a geometry that outlives its room map. The room map has many writers and none of them knows about the worker, so the reload lives where every write passes: a window's save of `roomMap` or `lastHueAreaId` re-applies the running mode 300 ms after the last one (`lighting-transaction.md`, "Settings refresh"), and the unforced re-apply reaches the worker through the geometry cell below rather than a restart. It used to be the main window listening to its own saves, with a retry around a dispatcher cooldown that dropped rather than queued; a save from any other window was never seen.

**A channel placement names its entertainment area, because `channelIndex` is unique only inside one.** `HueZone` has carried `entertainmentAreaId` since v1.5 (and the since-retired `hueChannelRegionOverrides` was keyed by it); `hueChannels` was the one place that was not, so two areas' channel 0 were a single record and the second area's placements overwrote the first's. The `4 → 5` migration backfills from `lastHueAreaId` — sound because one bridge is paired at a time and, until this landed, a second area *overwrote* rather than joined. A state with no `lastHueAreaId` is left unscoped rather than bound to an invented area, and an unscoped record is adopted by whichever area is being viewed. Treat empty as unscoped rather than testing for `undefined`: the field is nullable like `zoneId` because the Rust mirror echoes `None` back as `null`, and a strict `=== undefined` hides every round-tripped record from every area.

**The editor shows one area at a time, and the object-id scheme is why.** Room-map object ids are `hue-<index>` with no area (`model/objectId.ts`), so rendering two areas at once makes a selection ambiguous — every mutation matching on `channelIndex` alone would hit the same-numbered channel in the other area. `useRoomMapDocument` filters to the active `hueAreaId` and writes back through `replaceHueChannel`, which matches area *and* index against the full stored list. The filter has to cover every reader and writer keyed on an object id, not just the canvas: the object list, the inspector and the property bar once read the unfiltered config, and the nudge, typed-position, lock and zone-assignment paths matched on the index alone, so another area's same-numbered channel was listed, shown or moved. They all go through `model/hueChannelScope.ts` or the editor's area-scoped config now. Placing several areas independently is P3 work and needs a wider id first.

**Anything the Rust zone commands echo back has to exist on the Rust struct, or the round trip erases it.** The four `hue_zone` commands return the channel list and `useRoomMapHueZones` re-applies it wholesale, so a field present in TypeScript and absent from `models/room_map.rs` is silently dropped the moment a channel is assigned to a zone. `locked` had been lost that way since it was added; `entertainmentAreaId` would have joined it. Both are mirrored now, and a channel synthesised by `assign_channel_to_hue_zone` inherits its area from the zone, which belongs to exactly one.

**An editor's output is a subset, so it is merged into `hueChannels`, never assigned over it.** The panel only ever sees the channels one bridge is currently reporting. Assigning that array onto the config deleted every placement outside the view — another area's, and all of them while the bridge was unreachable. `mergeHueChannels` keeps the untouched records, which is the same rule as "the editor never deletes a Hue channel" applied to the save path rather than to a delete button.

**The one-shot fit has to read the dimensions live, not the ones present at first render.** `useRoomMapState` seeds `DEFAULT_ROOM_MAP` and swaps in the stored room a commit later, and the canvas container only mounts once loading ends — so a ref captured at first render always held the 5×4 placeholder, and *every* map was framed as if it were 5×4. A larger room then opened zoomed too far in, overflowing the canvas instead of sitting centred in it. The guard against re-fitting under a user who is editing the room size is `initialFitDone`, not a stale ref; the two were conflated, and a test had pinned the stale read as intentional with the reasoning that "a dimension change arriving before the container mounts must not become the basis of the fit" — but that change *is* the room finishing loading.

**A zone is a physical square in metres, which means its two cube-space scales diverge in a
non-square room.** The inspector edits one edge length; `scaleX` and `scaleY` are derived from it
against the room's width and depth independently, so a 1 m square in a 5×4 m room is not a uniform
fraction of the bridge's ±1 frame. Patches therefore pass through verbatim rather than mirroring one
axis onto the other, and Rust validates each axis on its own against the `HUE_ZONE_SCALE_MIN` /
`HUE_ZONE_SCALE_MAX` band and the cube-overflow invariant
(`src-tauri/src/commands/room_map/hue_zone.rs`). The frontend mirrors that band as a clamp; the two
constants have to move together.

`scaleZ` is the one scale Rust does not validate, because no control authors it: a zone is created
at 0.5 and the value is only read as the height slider's reach. It cannot arrive bad by accident —
a non-finite number serialises to `null` and fails deserialisation, loading drops non-finite zones,
and the live path clamps. A zone-depth control has to bring the Z band and its frontend clamp with
it, the way X and Y have them.

**A large zone's centre marker stops well short of the wall it is pinned against, so the pinned edge lights up.** `|center| + scale ≤ 1` means the centre can only reach `1 - scale`, and at that point the box edge is exactly on the wall — correct, but on a 5 m zone in a 9 m room the marker parks 2.5 m away from the edge holding it, and the drag reads as broken rather than finished. `pinnedZoneEdges` names the flush walls and the drag path writes them to `data-zone-pinned`; four CSS custom-property slots compose the inset shadow so a corner lights both its edges. The cue is a `box-shadow` rather than a `border-*` override because the bounds box sets `border` inline, and it is dropped in forced-colours mode, where a real border stands in. The comparison is tolerant rather than `===`: the drag compares against the bound `clamp` just returned so it would match exactly, but a centre round-tripped through the backend carries float noise and `-1 + 0.6` is not `-0.4`.

**The editor has one dock, and it deliberately has no Properties tab.** Object list, zone list and
zone properties used to be three peer panels at three different DOM positions; when a Hue zone was
active two of them sat side by side as 180 px columns, and on a narrow window the second one
overflowed past the canvas. They are now a single tabbed dock whose lower half is a type-aware
inspector. A Properties tab existed briefly and was dropped: the same inspector was already mounted
in the split body, so the tab could only ever render a "pick something" hint. Re-adding a tab per
object type recreates that redundancy — the inspector swaps on the active selection instead.

**Background images are copied in, capped at 20 MB, and pruned only at startup.** An imported
image is copied into `room-map-backgrounds/` in the app data dir under a UUID name, because the
`fs:allow-read-file` capability is scoped to exactly that directory and the source may be on a
removable disk. The canvas decodes the whole file into the webview, so `copy_background_into`
(`src-tauri/src/commands/room_map/background.rs`) refuses anything past
`MAX_BACKGROUND_IMAGE_BYTES` with `ROOM_MAP_BACKGROUND_TOO_LARGE`, checked from the metadata and
again while copying, since a file can grow in between. `ROOM_MAP_BACKGROUND_MAX_MB` in the
contract is the number the UI quotes; a Rust test holds the two equal.

A deleted layer leaves its copy behind, so the startup path deletes copies that no
`roomMap.imageLayers[].path` (or the legacy `backgroundImagePath`) names. It reads them through
`PersistedShellState::room_map_image_paths` in `shell_state.rs`, the file's only reader, never from
the file itself. It runs once, at startup, and never on import or delete: the editor's undo is in memory and can bring a deleted
layer back within a session, which would then point at a file already gone. Two more rules keep it
from deleting something live. A store without an `imageLayers` array prunes nothing — an unreadable
or reshaped `shell-state.json` must not read as "no image is used". And a copy younger than an hour
is spared, because a dev and a release build share the app data dir and the other may be in the
middle of an import.

## Gotchas

- **Several writers store `roomMap`, and every one of them goes through `shellStore.update`.** The editor, the USB roster (a strip on a connect), LED Setup's count sync and the Devices channel map all write it. The editor used to save the whole config from its reducer — loaded once, saved again on unmount, never listening — so a strip the roster added or a count LED Setup synced while it was open was taken away by its next save; only `SettingsLayout` mounting one section at a time kept that from happening. Now the editor keeps a baseline (the map as it last loaded or saved it) and writes only what changed since, through `mergeEditorSave` (`model/roomMapMerge.ts`): top-level fields by reference, and `usbStrips` and `hueChannels` record by record — keyed by `stripId` and by area plus `channelIndex` — because the other writers write those two. What the editor added or changed wins, what it deleted goes, everything else stays as stored. A record the editor changed takes only the fields it changed, so a `portName` the roster stamped or an `ledCount` LED Setup synced on the same strip stays. The first baseline is the stored map before the legacy-background conversion, so that conversion reaches the file. Saves run one after another, the first at once so the unmount flush is under way before the editor goes, and each reads the baseline when it runs rather than when it was asked for: a save queued behind one that failed then writes the whole map, where it once wrote only its own change and lost the failed one's. Two writers changing the same field of the same record is still last-writer-wins. `verify:shell-contracts` fails on a `shellStore.save` or `saveShellState` that names `roomMap` or `hueBridgeSyncedPositions`. `roomMapVersion` was retired at schema 10 — everyone bumped it, nobody read it.
- **The TV anchor's `x`/`y` is the footprint's top-left corner, not its centre.** The contract says
  so, the canvas draws it so, and Rust's room-aware sampler adds half the width to find the screen
  centre. The one frontend reader that took it for the centre — the since-removed "LED counts from
  the map" — put every derived edge half a TV up and to the left of the drawn one, and a test had
  pinned that. A new reader of the anchor converts from the corner.
- **Resizing the room moves metre objects, never Hue channels or zones.** TV, furniture, strips and
  image layers are in metres and shift by half the growth so they keep their place around the
  centre. Channels and zones live in the bridge's `[-1, 1]` cube, which spans the room, so they
  already follow the new size; adding the metre shift to them once pushed a channel at `x = 0.5`
  in a 5 → 7 m resize out to `1.5`, off the cube.
- **"Reset map" is an empty template, not the empty map.** It goes through `applyRoomTemplate`
  with `DEFAULT_ROOM_MAP`, so the Hue channels and zones (the bridge sync's) and every port-linked
  strip (Devices') survive, the first one keeping its placement. Writing `DEFAULT_ROOM_MAP` over the
  config once wiped all three, and the map then disagreed with both owners until they re-synced.
- **Editor shortcuts stand aside for form fields.** The editor root owns Delete/Backspace, Cmd+Z,
  arrows and the rest, and the dock's fields sit inside it: Backspace in the on-canvas LED count
  deleted the strip, and Cmd+Z in a field ran the editor's undo instead of the field's own.
  `handleKeyDown` returns early for an input, textarea, select or contenteditable target
  (`shared/lib/editableTarget.ts`, the same test the global keybinds use). Space-to-pan has one
  owner too — `useRoomMapViewport` — with the canvas reading its `panMode` rather than keeping a
  second window listener that swallowed a space typed into any field.
- **The 3D room reads each piece's model from its size and its neighbours.** The stored types are
  four words (`sofa`, `table`, `chair`, `other`) and say little on their own, so
  `room-view/ui/scene/furniture.ts` reads the model the way a person reads a floor plan: a seat grows
  from a slipper chair through an armchair to a five-seat sofa with its width (one cushion per
  0.62 m between the arms); a table is a desk when the screen stands over it, the desk's return when
  it touches one, a coffee table in front of a sofa, a side table when small, else a dining table; a
  small chair at a desk is an office chair, a wide shallow one a bench. Every part stays inside the
  footprint the 2D map gives the piece, at any size — the containment test runs each model at five
  sizes, including a 3.81 × 0.17 m piece a user really drew. The reading lives in the three-free
  `room-view/model/furnitureModel.ts`, so the inspector can say what "Auto" reads as without the 3D
  chunk.
- **A user's pick overrides the reading; it never replaces it.** `FurniturePlacement.variant` (a
  table's desk/coffee/dining/side, a chair's dining/office/armchair/bench, a sofa's straight or
  corner, storage's sideboard/bookshelf/wardrobe/nightstand/TV unit, a plant's habit, a rug's shape)
  and `tone` are optional; absent is Auto, and `TvAnchorPlacement.screenKind` does the same for TV
  or monitor. `FURNITURE_CATALOGUE` says which type takes which. Three rules hold them together:
  - Every reader goes through `resolveFurnitureType` / `resolveFurnitureVariant` /
    `resolveFurnitureTone`. A type from a newer build reads as `other`; read directly, it threw on
    the plan's colour table the moment the room map opened.
  - Nothing normalises on load. The editor writes `furniture` as a whole array, so a load-time
    clean-up would delete a newer build's choice on the next edit; a value the type does not take
    reads as absent and stays stored.
  - A type change is the one place that clears (`retypeFurniture`): a variant or tone the new type
    does not take goes, because `dining` means a table and a chair alike and a spread would carry it
    across silently.
  The piece's own height is `topMeters` — `height` on this type is the footprint's depth (and the
  inspector now says Depth for it). `screenKind` is the editor's alone: Rust receives it in the file
  it owns but never mirrors or projects it — `toRoomGeometry` copies the anchor field by field, and
  the shared parity fixture pins it. `resolveScreenKind` and `resolveFurnitureTop` read the two
  without a type's help, so a value from a newer build or a hand-edited file reads as absent. The
  model, tone, height and screen choices are offered only where the 3D room is built
  (`ROOM_VIEW_3D_AVAILABLE`): nothing stores what nothing draws. Their inspector edits carry a
  gesture key, because a chip or swatch group selects on every arrow key and each save re-applies
  the running mode.
- **The 3D room keeps its draw count fixed.** Furniture merges into one matte and one satin mesh by
  vertex colour; bulbs, halos (one `Points`), floor pools and wall washes are one draw each whatever
  the lamp count; contact shadows are geometry with per-vertex alpha merged into one mesh — a
  stretched blur texture smeared on a long sofa — and include a soft band along the foot of every
  wall. The night backdrop is a CSS gradient behind a transparent canvas, so it costs no draw.
- **Bare keys belong to the canvas; modified ones to the whole editor.** Arrows, Delete/Backspace,
  R, F and Escape act only when the event comes from the editor root or from inside the
  `data-room-map-viewport` element. On a dock tab, a segmented control or a menu item an arrow moved
  the selection along with the control, and Delete removed the selected object. Cmd/Ctrl+Z, +D and
  +0 stay editor-wide. The window-wide Space listener also leaves a button, tab, radio or menu item
  alone, because Space is how those are pressed.

- **A Hue channel carries two positions and only one is live.** Once `zoneId` is set,
  `zoneRelativePosition` is what the canvas paints and the absolute `x`/`y` are leftovers. Three
  call sites derived that independently: the overlay correctly, keyboard nudge and the property bar
  not — so nudging a zone-bound channel wrote a field nothing reads, and the readout showed a
  coordinate the dot was not at. `model/hueChannelPosition.ts` is now the only place that resolves
  or writes a channel position; go through it rather than touching `ch.x` directly.
- **The lock has to be checked by every mutator, not just delete.** `deleteById` consulted
  `isLocked` from the start and `handleRotate` / `handleArrowNudge` never did, so a locked object
  stayed keyboard-movable — a lock that holds against the mouse and not the keyboard reads as
  broken rather than partial.
- **A refused Hue zone mutation arrives as a *resolved* promise.** The four `hue_zone` commands only
  reject on IPC-transport failure; a validation refusal comes back as a non-applied `status.code`
  with HTTP-200-shaped success. Six mutators in `useRoomMapHueZones.ts` held nothing but
  `.catch(console.error)`, so every refusal was structurally invisible and the invalid zone the
  frontend had already written optimistically stayed in `shell-state.json`. `isHueZoneApplied` in
  the contract is the discriminator; read it, and re-apply the `zones`/`channels` the backend hands
  back.
- **That reconciliation only works if the payload carries the *pre*-mutation lists.** `existingZones`
  is both the input the command validates against and the pre-image it echoes on refusal, and the
  commands perform the mutation themselves. Sending the already-mutated list made a refusal return
  the very state it refused — and in `assign_channel_to_hue_zone` it made `already_in_zone` always
  true, so the per-area channel cap never ran at all.
- **The scale clamp and the bounds check are two different rules, and the inspector only knew one.**
  Rust refuses both `scale ∉ [0.05, 1.0]` and `|center| + scale > 1`. `HueZoneInspector` clamped the
  first, so growing a zone parked against a wall authored a state the backend refuses. The edge
  maximum is bounded by the centre's remaining headroom; the drag path in `HueChannelOverlay` had
  always done this, which is why only the inspector could produce it.
- **WKWebView strips custom MIME types from a cross-element drag payload.** A channel dragged onto a
  zone header arrived with an empty `getData("application/x-lumasync-channel")` under Tauri's macOS
  webview, so the drop silently fell through. The index is written into `text/plain` as well as the
  custom type, and there is an in-memory fallback behind both. Separately, both Chromium and WebKit
  need `preventDefault()` in `onDragEnter` — not just `onDragOver` — or the browser cancels the drop
  with a "no" cursor before `onDragOver` ever fires.
- **The dock inspector needs a `key` per selection or in-flight typed text leaks between objects.**
  The dispatcher returns the same component identity for two different USB strips, so React reuses
  the instance and the number field's local draft string — the value the user is mid-way through
  typing — travels to the next object. Two strips on different ports both showed whichever was
  selected last. The key is `kind:id`, so it changes even when the kind does not.
- **A derived world position can be `NaN` and React will stamp it into `style.left`.** `pxPerMeter`
  is briefly 0 during mount, and a failed `update_hue_zone` mid-drag leaves a zone centre stale, so
  the projection has real ways to produce `NaN`. React warns (`setValueForStyle: NaN is invalid`)
  and the dot leaves the canvas. Every projection falls back to 0, and the imperative drag path
  needs the same guard as the render path — it bypasses render, so it does not inherit it.
- **Zone drags move the DOM imperatively, not through React.** Moving a zone centre has to move the
  dashed bounds box and every dot bound to that zone together at pointer-event rate; a re-render per
  move is too expensive. The handler caches each node's start position and applies the delta
  directly. The dots' persisted `zoneRelativePosition` does not change — only the world position it
  projects to.
