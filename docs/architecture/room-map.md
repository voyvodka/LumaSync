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
room. The room's WebGL view is not closed with it but parked for 20 s (`park` / `unpark` in
`RoomView3D.tsx`): its canvas comes off the page and stops drawing, and the next 3D view to open —
the other face, or Edit's 3D stage after the plan — adopts it with its scene and camera. A new
context, its shaders and the scene took about half a second plus the fade on every switch, a pause
the maintainer saw each time. The park ends early when the window is hidden or the view never
finished compiling. Hidden means put away — to the tray, or minimised — and the view goes at once.
Covered by another window or another Space, the window's document reads hidden too, but the view
stays mounted for 30 s (`COVERED_KEEP_MS` in `RoomView3DHost.tsx`, read from `useWindowPresence`):
flicking between windows rebuilt the room on every return.

**A new view compiles the programs the bloom draws with, not the canvas's.** three keys a program
on its render target and on the shadow switch, and the bloom draws the room twice into its own
targets — lit, and darkened with shadows off — so `compileAsync` on the canvas built programs
nothing drew, and the first frame compiled the real ones on the main thread: 1.9 s on a cold open,
measured, while the stage showed an empty night. `Bloom.compile` compiles both passes' programs
before the view counts as ready; the first frame then took 40 ms. The stage keeps the map's
loading line up until that frame is drawn (`onDrawn`), carrying on from the map's own on a first
open and held back 200 ms on a rebuild so a quick one never shows it; a parked view is adopted
already drawn and shows none. It is not held for the busy minimum (`useHeldFlag`): that kept it over
a room already drawn. Three.js starts loading while the map is still read
(`preloadRoomView3D`).

So the room holds still across View | Edit, and only the chrome arrives: the
dock's box stays where it was while its content rises 4 px into it, and the corner drops 4 px into
place. A stage switch fades the new surface, and the corner slot's zoom or camera, under a dock, a
corner and any alert that stay. A pick from the first-run templates fades the whole face in. The distances live in the keyframes, because WebKit drops a
`var()` read inside one. The one thing a switch drops is the
plan's zoom and pan, which fit the room again on return. The View | Edit switch is the surface's
own, floating over both faces' top bars, so a keyboard switch keeps focus on it. The face is not
stored: the map always opens on the room, and an empty map with no history opens on the templates
before either face. Empty means nothing the user placed: the strip a connect on Devices links and the
Hue channels the bridge sync seeds do not count, since the sync lands a moment after the map opens
and once took the picker away under a first-time Hue user's pointer; a template keeps both.

**Over a room, the templates are a drawer above the dock, and the room behind is the preview.**
Templates, in the dock or the room's settings, opens them over the room instead of replacing it,
so a template is judged in the room it would become. The card the pointer or the keys rest on for
160 ms is shown in place of the room — laid out by `applyRoomTemplate`, so the strips and lights
kept are the ones a pick would keep — and leaving the cards shows the room again; a sweep across
them builds nothing on the way. A preview is only looked at: nothing reaches the map or its
history, the selection reads as none (it may name a piece the template lacks), and the stage
under the drawer takes no press. A pick is one undo step and leaves the editor where it is. The
plan fits each previewed size and goes back to the zoom it was left at; the 3D view keeps the
camera it had for each room size, so leaving a preview finds the room as it was being seen. The
full-page picker is only the first run's.

In 3D each change to or from a template plays out piece by piece (`planMorph`, `scene/morph.ts`):
the new room is built at once, then pieces of a kind are paired nearest first, both rooms measured
from their middles since the ids never match, and each pair slides, turns and stretches from where
it stood; a piece the new room has no place for is pressed down into the floor, and one it adds
grows up out of it, nearest the middle first. Every moving piece is a lifted copy for the ~0.6 s,
the ones going rehomed out of the old scene before it is disposed; a press, a carry or another
change ends it at once, and reduced motion skips it. The walls and the room's size change at once:
a wall is not a piece that lifts. The editor marks such a change with `morphKey`, so an ordinary
edit never morphs.

**View changes every light at once, never one.** The corner's lights button (`view/RoomLights.tsx`)
opens `QuickLights` — the column the tray window draws — in a popover: mode, brightness, Solid's
colour and white, the effect. It writes through the same lighting control as Lights, so the room's
mood follows on the next frame. A single light's colour is not offered: the running mode drives every
output, and a per-light override would need a contract the modes do not have. Scenes stay off it;
they are a page's choice, and the popover keeps to what the room changes as you watch.

**Edit draws the room in 3D or as the plan, and the dock is the same for both.** The editor's stage
— 3D | Plan in its corner — swaps only what the room is drawn as: `RoomView3DHost` or
`RoomMapCanvas` in the same slot, under the same dock, history, keys and save. So everything the dock
does is done in 3D too: the palette adds a piece on free floor, a pick in the room opens its card,
Delete, ⌘Z and the arrows work, and a selected piece or light is carried and turned
(`useLandCarried`). View carries nothing: it is for looking at the room and its lights, and a drag
there that moved the sofa while turning the room was a layout change made by accident. What only the plan draws stays there — the
walls' handles, a strip's ends and corners and image layers — so picking or adding an image opens the
plan for it once the file dialog returns one, and going back to 3D closes that card. A Hue zone is
drawn in 3D as well (`scene/zoneBoxes.ts`): the zone being edited, or else the selected light's, as a
low wall in its colour that rises from the cube's bottom and fades upward, over a solid outline of its
footprint on the floor below, named over its highest corner on screen (over the top's middle the name sat on the lamp inside), and with the zones
toggle the area's others faintly, as the plan draws them. So a zone picked or added stays in the 3D room,
and its card stays open across a stage switch. The boxes are built with the scene and only shown or
hidden after, so picking a zone rebuilds nothing. A drawn zone is picked in 3D under everything else:
only where the press finds nothing but its floor (`model/zoneGesture.ts`), because its box stands round
the furniture inside it and a nearest-hit rule gave it the sofa's clicks. It is carried from its floor
and resized from eight grips only when it is itself the selection (`ZoneMarks.held`), not when it is
shown for a selected light, whose drag carries the light. The grips keep the room's proportions, and
⇧ while carrying raises or lowers it along the upright plane facing the camera, as a raised light
rises, held between the floor and the ceiling. While held it is drawn as its whole cube; at rest the
low wall keeps the furniture readable. One write on release, through the plan's own zone handlers: a
live write rebuilt the room on every move. Carried or raised, only its centre is written, so a zone
against a wall stops there instead of shrinking. They are flagged `OVERLAY` for the glow pass, which hides them: its black stand-in
for every other mesh writes depth, and a zone's box drawn that way put out the bulbs inside it. A loose
light let go inside a drawn zone's cube joins it, on the plan or carried in 3D, at the spot it was put
down (`model/zoneDrop.ts`); the smallest zone wins where they overlap. One over a zone's floor but
above or below its cube stays loose, since joining would cut its height to the cube's. Only a drawn zone takes it — the
one being edited, or every zone of the area with the zones toggle — since one hidden took the light
unseen. The inspector's zone picker still assigns, at the zone's middle. The plan's own switches and keys step aside in 3D: the grid and zone-outline switches
are hidden, ⌘0 is the camera's Whole room, the arrows with nothing selected do nothing, and the keys
list drops panning and box selection. Edit opens on the 3D room where it is built; the stage picked
is remembered for the session, like the face, and not stored. A room that cannot open in 3D falls back to the plan with
no stage switch, through the same failure the View face reports. In 3D the camera's buttons take the
plan's zoom slot in the same capsule, which keeps the zoom's width, so the stage switch and undo stay
under the pointer when the stage changes. A second 3D stage instead of moving the dock into View
was chosen because the editor's actions — some forty callbacks over the map, its zones and images —
would otherwise be built twice.

**A piece stores a name only when the user gives it one.** Templates and the library used to write
the type's or model's name into `label`, in the language of the day, so a room laid out in English
still read "Sofa" after a switch to Turkish. Now a piece without a name of its own is called by its
model, else its type, at draw time (`model/furnitureName.ts`), and every reader goes through it. A
stored label that is one of the names earlier builds stored, in English or Turkish, counts as no
name, so maps saved before the change follow the language too, with no migration. Those names are a
frozen list in the module, not a lookup through i18next: a window loads only its own language's
catalogue, so an English name was unrecognisable in a Turkish window after a restart. The list is
the same for every type, so a "Sofa" retyped into a chair reads as a chair. The price: a user who
names a sofa "Sofa" by hand sees it translated.

**The plan draws a piece the way the 3D room builds it.** `objects/FurnitureGlyph.tsx` draws each
piece from above from the same `FurnitureModel` the room reads (`useFurnitureModels`, which keeps a
model object while the piece's reading holds, so an edit re-renders only the pieces it changed), in
the same colours (`furnitureColours`, shared with the room's materials) and to the same rules — an
L only where `cornerFits`, a seat facing the TV wall unrotated. Each drawing stays inside the
piece's footprint at any size, as the 3D models do; `FurnitureGlyph.test.tsx` holds that for every
model. The template cards draw their rooms with it (`RoomPreview`).

**Every typed number is one field, and the inspector holds them all.** `ui/DecimalField.tsx` is
the room map's only number input: the inspectors' position, size, height and rotation, a strip's
LED count, a zone's size and height and the room's size. It reads as a value at rest, applies on leaving or
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

**A dragged Hue light meets the same guides as a piece, and the other lights as points.** It snaps
to the TV, the furniture's edges and centres, the room's middle and each other light's stored
position (not where a stack fans it out to), then its zone's bounds clamp it; ⌥ drags it free. Only
a light takes the lights as targets: a sofa caught on every bulb would never sit where it was put.
The guides read the shown area's lights, so another area's never pull one.

**Channel-to-zone assignment keeps three shapes in sync by hand.** One handler serves both ways a
light changes zone — the zone picker in the light's inspector and the light chips in the zone's —
because both have to write the same three fields: the channel's `zoneId` (the join key), its
`zoneRelativePosition` (reset to the zone centre, refined by dragging), and the zone's
`channelIndices` (denormalised for the runtime sampler). Letting those drift desyncs the frame
builder from the zone-cap validator. Both offer only the shown area's zones and lights, since a pick
across areas is one the backend refuses, and both hold still for a locked light: joining a zone
moves it to the zone's centre.

**Hue channels are bridge-managed; the editor never deletes one.** Only the Hue app or the bridge
can remove a channel from an entertainment configuration, so LumaSync has no delete affordance for
them. An earlier build spliced them out of `config.hueChannels` by array index, which detached the
channel from its zone in a way the user had not asked for *and* shifted every later channel's slot.
A light leaves its zone through its zone picker instead. Anything reaching for a channel by array
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

**A zone is a cube in the Hue space: one scale on all three axes.** The Hue frame is unitless:
every axis runs −1 to 1 and the room is stretched onto it per axis (width to x, depth to y, height
to z). A zone's `scaleX`, `scaleY` and `scaleZ` are one value, so on the plan and in 3D it draws as
a box in the room's proportions, the same share of each side. This is the shape the Hue app's own
entertainment-area editor works in, and the bridge never sees a zone — only the positions resolved
through it (`hue.md`, "Entertainment positions"). A bound light stores its place relative to the
zone's centre, so moving or resizing the zone carries its lights with it; a dragged bound light is
held inside its zone and leaves it only through its zone picker. Loose lights and overlapping zones
are both allowed. The dock edits the size as a share of the room with the sides in metres beside
it, and the centre's height; the plan draws one with a drag in the room's proportions ("Add zone"
arms the draw, a click drops the cube of scale 0.5) and reshapes it from eight grips on the active
zone's box, which keep the proportions and move the box, its centre, its name chip and every bound
light in place before writing the zone once on release (`model/zoneRect.ts`). Every write goes
through `withCubeScale` (`model/zoneCube.ts`), which clamps the scale to the band and the centre so
`|center| + scale ≤ 1` on every axis. Rust validates the same: the `HUE_ZONE_SCALE_MIN` /
`HUE_ZONE_SCALE_MAX` band on each axis, equal scales (`HUE_ZONE_OVERSIZED` otherwise) and the
cube-overflow invariant on all three axes (`src-tauri/src/commands/room_map/hue_zone.rs`). The
frontend's `ZONE_SCALE_MIN` mirrors the band; the two constants have to move together. An earlier
build kept the two floor sides independent and spanned every zone floor to ceiling; that let one
zone's lights sit in a box the Hue app could not draw.

**A file an older build wrote is made cubic where it is read, and no light moves.** The `11 → 12`
migration (`cubeZonesV12.ts`, a frozen copy so later changes to the live helper cannot rewrite
history) gives each zone the larger of its floor scales, grown to cover its bound lights' spread,
with its centre kept where it fits and its height at the middle of its lights. Each bound light's
relative position is then rewritten from the new cube, so it resolves where it did. The same
`cubeZones` runs on every load and room switch, because a v11 build can still write a non-cube zone
into a v12 file. Before v11, zones were made at `centerZ 0, scaleZ 0.5`, which held every bound
light to the middle half of the room's height; `10 → 11` opened them floor to ceiling, keeping each
light's height. Readers keep the general `center + scale · relative` formula on every axis.

**A large zone's centre marker stops well short of the wall it is pinned against, so the pinned edge lights up.** `|center| + scale ≤ 1` means the centre can only reach `1 - scale`, and at that point the box edge is exactly on the wall — correct, but on a 5 m zone in a 9 m room the marker parks 2.5 m away from the edge holding it, and the drag reads as broken rather than finished. `pinnedZoneEdges` names the flush walls and the drag path writes them to `data-zone-pinned`; four CSS custom-property slots compose the inset shadow so a corner lights both its edges. The cue is a `box-shadow` rather than a `border-*` override because the bounds box sets `border` inline, and it is dropped in forced-colours mode, where a real border stands in. The comparison is tolerant rather than `===`: the drag compares against the bound `clamp` just returned so it would match exactly, but a centre round-tripped through the backend carries float noise and `-1 + 0.6` is not `-0.4`.

**The editor's chrome is one floating dock of fixed height, and the plan gets the rest.** A toolbar
above, chips down the left, a 300 px side dock and a coordinate readout used to take a quarter of the
window and every fit's zoom with it. Now the plan fills the face; the View|Edit switch, a corner
capsule (undo, redo, zoom, the keys) and the room-aware pill float over its top, and one 92 px dock
floats over its foot (`ui/dock/`). While nothing is selected the dock's slot is one quiet row — Add,
the templates and the Hue area's state — and Add opens the library above it: shelves of cards, each
piece drawn as the plan draws it, at a fixed height so a change of shelf moves nothing. There are
two shelves: Furniture, led by the TV, and Light, which holds the LED strip and, with a Hue side, a
zone — a third shelf for the screen and the strip split the lights in two. Two rows of
tiles in the slot left no room for kinds the room gains, and the image, which traces the room
rather than furnishing it, moved to the room's settings. With a selection the slot holds its
two-row inspector; the rail opens the objects list and the room's settings as popovers above it.
The height never changes with what it shows, so nothing above it moves, and `ROOM_MAP_FIT_INSETS`
keeps a fit's room clear of both bands. The objects list is the keyboard's way to select furniture,
the TV, strips and images at all, and the way to reach a piece the dock covers. A selection made
from the dock lands keyboard focus on the inspector's first field and gives pointer focus back to
the editor root; one made on the canvas leaves focus alone and is announced instead. Escape in the
dock goes back to the editor without letting go; on the canvas, and on ✕, it steps back one
selection — an object, then the zone it was picked over, then the palette — and a click on empty
ground lets go of both (`clearSelection`), since `select(null)` alone left a zone selected under the
palette.

**A furniture or TV card dragged out of the library is the piece itself until it is let go.** Past
the click slop the drawer closes and the card's real model floats on the 3D floor under the pointer
(the plan draws its glyph instead), warm-tinted over an amber footprint band, so it never reads as
a placed piece; where its middle falls outside the room the band turns red (dashed on the plan) and
the cursor says no. Letting go adds it there in one history step and selects it, the 3D ghost
sinking the last 12 cm onto it; Escape, letting go over the dock or off the room, or the window
losing the pointer adds nothing. Nothing reaches the map, the history or the selection while it is held,
and the view only moves a ghost (`RoomDropTarget.preview`): a build per pointer move is what the
carry's lift was made to avoid. The drag listens on the window, since the card goes with the drawer;
it eats the one click the drag ends with, which on the plan's floor would deselect what just landed,
and takes Escape in the capture phase, ahead of the editor's own. Strips and zones stay click-only:
both are placed against a wall or a light, not on the floor. The drawer is its own chunk, fetched when
Add is reached, to keep the room map's chunk under its budget.

**The View face selects lights, not furniture, and shares the selection with the plan.** The 3D
room is drawn as a few merged meshes, so a raycast against them cannot say which piece it hit; the
scene hands back one oriented box per light, piece and screen (`room-view/model/picking.ts`) and a
click tests the ray against those. A light the ray passes through wins over a nearer piece, so a
lamp on a desk or half behind the sofa is still the one clicked, and a light is picked as if it were
at least 32 px across at the current zoom. A press that moves more than 3 px turns the room instead,
as on the plan. A click on furniture keeps the light that was selected — View has nothing to say
about a piece, and Edit is one switch away — and a furniture or image selection made in Edit is shown as nothing in
View but left stored for the way back. The selection's mark (`scene/selection.ts`) is moved, never
rebuilt: a floor outline under a piece, a frame in front of the screen, and for a light a ring that
faces the camera, never under 20 px, with a faint copy drawn through whatever stands in front. The
View dock is the editor's box (`ui/dock/DockFrame.tsx`) without a rail: the lights as chips, or one
light's card with identify, how it reads now and how bright the room is, and the way to the plan.
Identify sends an empty key, which the command resolves from the keychain, so the room never holds a
credential; a strip, or the screen through its backlight strip, blinks through the Devices page's
flash instead, sized by the layout of the strip on its port. The card keeps its second row's
end and its facts' width for a power switch and a brightness bar, so neither moves anything when
per-light control arrives; until the live feed reaches the view, the lamps' colours are placeholders.

**A room that is not a rectangle is an outline over its dimensions, never a replacement for them.**
`roomMap.footprint` holds 4, 6 or 8 corners of an orthogonal outline (an L, U or T) in plan metres,
read only through `resolveRoomFootprint` in the contract: anything it cannot use — diagonal or
touching walls, a wall under 10 cm, a box that is not exactly `[0, W] × [0, D]` — reads as the plain
rectangle, and nothing is ever scaled to fit or written back on load. `dimensions` stays the bounding
box and the only shape Rust sees: the Hue cube mapping, room-aware affinity and the emitters all use
it, so a lamp standing in a notch is sampled as if the room were the full rectangle. That is a
knowing simplification; the outline decides what the room looks like, not how it is lit. A writer
removes the key for the plain rectangle and changes it with `dimensions` in one apply, so the two
never disagree on disk; an empty room drawn into an L is no longer offered the templates. On the
plan, the walls inside the room's box are handles (`ui/objects/FootprintWalls.tsx`): a drag moves
one along its normal to the centimetre and stops at the last outline the contract accepts, and a
double-click on a plain room's wall cuts a U notch — only there, since eight corners is the most an
outline may have. The handles sit under every object, so a piece against a wall is still the piece
you grab; they are pointer-only, and the Shape row is the keyboard's way to the same shapes.

**The room's finish is the editor's alone, and an unknown value is kept.** `roomMap.surfaces` names
the floor (`FLOOR_FINISHES`) and the walls' paint (`WALL_COLORS`) from named lists of ten — no hex, so
the palette stays one the lights read well against, and the colours live once in
`room-view/model/surfaceColours.ts` for both the 3D room and the Room settings discs. Only the 3D
view draws it; Rust neither mirrors nor rewrites it (a Hue forget keeps it, `forget.rs` pins that).
`resolveRoomSurfaces` reads it and never writes: a pick spreads over what is stored, so a floor a
newer build chose survives this build changing the walls. A template keeps the room's surfaces, and
so does Reset map, which is the empty template: it clears the layout, not the finish. A
pick is a gesture, since every `roomMap` save refreshes the running mode. Glass walls were left out:
a second wall material breaks the scene's fixed draw count, and they wait for their own change.
The lists' order is the discs' order, light to dark and the woods first, so reordering the keys is
free — nothing stores an index. Every pattern is real geometry merged into the floor's one draw:
herringbone lays 9 × 45 cm planks on the lattice n·(w, −w) + m·(l, l), one plank along each axis per
point, which tiles with no gap and no overlap (`environment.test.ts` samples the floor for both); a
checkerboard counts its squares from the room's corner so a notch does not shift the grid. A disc
shows its pattern in CSS (`floorSwatchCss`): rows, a diagonal for the zigzag, a grout grid, a
checker. Ten in one row ran out of the panel, so each set is two rows of five. Herringbone is the
costly one to build: a 10 × 8 m room is about 2,000 planks and 8 ms to lay against oak's 300 and
1.6 ms (Node, M4 Pro), once per scene build and still one draw.

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

**A press is a click until it has moved 6 px, and only then a drag; Esc puts a drag back.** One
rule for every handle on the plan and in the 3D room (`CLICK_SLOP_PX` in `snapGeometry.ts`, read
through `ui/objects/dragIntent.ts`). At 3 px a trackpad click's wobble moved what was only being
selected — for a Hue light that meant a write-back to the bridge — and the strip, the zone centre,
the frame's handles and the image layer had no threshold at all. Once a press passes the slop the
carried element takes `data-dragging`, which the plan's stylesheet lifts with a shadow (no size
change: nothing moves under the pointer but the piece), and it stays a drag even if it comes back
near its start. Esc mid-drag restores the start and writes nothing, caught on the window ahead of
the editor's own Esc so the selection survives. A drag also stops at the room's walls, the same
`keepPlacedInside` / `keepStripInside` that typed positions and arrow nudges go through.

In Edit's 3D room only the selected object is carried (`pressStartsCarry` in
`room-view/model/carryIntent.ts`); a drag that starts on anything else turns the room. Carrying from
any press made turning the room from over the sofa move the sofa — most of the view is furniture.
The cost is one click before a move, and the camera hint says so. Furniture, the TV, a strip and a
Hue light can all be carried; the selected one is taken wherever the press lands on it, even behind
something nearer (the TV's backlight strip covers the TV). It is dragged across the level it stands
at, so a pendant follows the pointer rather than the floor under it, and it lands through
`landCarried` (`model/carryLanding.ts`), the same per-kind adapters a typed position uses: a light
stays in its zone and everything stops at the walls. Only furniture turns. The TV takes its
backlight with it — a strip whose middle is within a metre of the screen's (`model/backlight.ts`,
the rule the 3D room draws backlights by) — on the plan too, so moving the screen never leaves its
backlight drawn as a stray line along the wall.

**The backlight can be named instead of guessed.** `tvAnchor.backlightStripId` binds one strip, or
`null` says the screen has none; absent keeps the metre rule, so older files read as they did and
need no migration. A bound strip is put back behind the screen on every reducer `apply`
(`seatBacklight`), its own drag included: the binding is the user's word for where it sits, and a
strip dragged off the screen would light the room as a backlight from across it. A lock does not
exempt it, for the same reason: the plan would draw it across the room while the 3D room still lit
and picked it as the screen's. An id naming no
strip reads as absent, and deleting the strip clears it. Like `screenKind`, the field is the
editor's alone — Rust stores it in the file it owns and never reads it — so the inspector offers
it with nothing below changing.

The carried piece itself follows the pointer, not a stand-in. The scene merges every piece into one
mesh per finish, so a piece cannot be moved on its own, and rebuilding the scene costs about 40 ms
for the Showroom — far over a frame. On the first move, `RoomScene.lift` copies the piece's vertices
out of the merged meshes into a group of its own and collapses them onto the origin, a zero-area
point (`room-view/ui/scene/lift.ts`), so nothing is rebuilt while it is held. On landing, the scene
rebuilt from the landed room replaces both. A refused landing, Esc, or a rebuild by another writer
mid-carry copies the vertices back. A wheel turn before the first move lifts the piece too. A desk
carries the monitor standing on it: the screen rides along without turning and lands by as far as
the desk did (`landCarriedWith`), in one undo step. Left behind, the screen hung in the air and then
stood on nothing. A lamp on a piece does not ride. A Hue lamp is not lifted at all, because its
light and glow are built into the scene, so it moves as the amber frame alone.

The inspector's X and Y take the same path. Stepped or dragged, each step rebuilt the room —
about 90 ms a step in the furnished Showroom, so dragging the field stuttered. A config that differs
from the one the scene was built from only by one piece, the TV or a strip slid across the floor
(`pieceNudge`) lifts that piece without its riders, which the inspector does not move, and slides it
and the selection's mark; the room is built once the edits rest for 250 ms (`SETTLE_MS`). Any other
edit within 200 ms of a build waits for that rest too, rather than building on every step. A press
in the room builds a waiting one first, and a landed carry builds at once, so a carry never lifts a
piece already lifted. A Hue light, or a strip behind the TV, has nothing to lift and builds as any
other edit does: at once, or at the rest when a build was under 200 ms ago.

Such a build was dearer than it needed to be. Freeing the old scene before the new one drew released
its programs, so each step compiled them again on the main thread (about 30 ms in Chrome, more in
WebKit); the old scene is now freed after the next draw. Generating the rounded boxes was half of
`buildRoomScene`; `block` copies a kept template instead. A height step on a Hue light in the
Showroom fell from about 60 ms of main-thread work to about 16 ms.

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
- **A strip's height is the 3D room's alone.** `UsbStripPlacement.mountHeightMeters` is optional and
  drawing-only: Rust reads a strip's id and port and nothing else, so there is no mirror. Absent, a
  strip within 25 cm of a wall runs at the skirting and one further out lies flat on the floor
  (`defaultStripHeight`, `model/stripWall.ts`), which the inspector shows as the field's placeholder.
  `resolveStripMountHeight` takes any finite height at or above the floor with no cap — a room can be
  8 m tall — and the 3D room holds it under its own ceiling; a ceiling lowered under a stored height
  keeps the number in the field while the strip is drawn just under the new ceiling, with no warning
  as the TV's mount height has, since nothing but the drawing reads it. A backlight strip has no height field:
  it is drawn at the screen. The tape is drawn at its real size, 12 × 4 mm, flat against its wall or
  the floor. "Onto the wall" (`stickStripToWall`) lays a strip along its nearest wall 1 cm inside it,
  at its length and running the way it ran. A template moves the strip to its own placement, so the
  height goes with the old place.
- **LEDs per metre make the length; the length never makes the count.** `ledsPerMeter` (1–300,
  `resolveStripDensity`) is the tape's, so a template carries it with the linked strip's LED count.
  With it set, an LED count or density committed in the card or on the canvas refits the run
  (`fitStripLength`, then `keepStripInside`): 90 LEDs at 60 a metre is 1.5 m, the end moved along the
  way the strip runs. Dragging an end changes the run, never `ledCount`, and LED Setup's count sync
  writes `ledCount` alone — refitting there would write the geometry the editor writes and lose a
  drag to last-writer-wins — so a run that no longer matches shows "Fit to … m" in the card instead.
  A refit happens when the count or density *changes*, not when a patch names them: "Onto the wall"
  sends the whole strip, and keying on the field's presence resized a strip it only moved. The TV's
  backlight never refits and is offered no fit — its LED count is the screen's perimeter, and the
  run grown to it carried the strip's middle off the screen, so it stopped being the backlight. A
  fit longer than the room is not cut: `keepStripInside` only slides, so the strip starts at its near
  wall and runs out past the far one.
- **A strip bends at its `corners`, absolute room points between its start and end.** Optional,
  drawing-only and at most eight (`MAX_STRIP_CORNERS`); `resolveStripCorners` reads any bad entry as
  a straight strip rather than a half-bent one. The array is one value: a patch replaces it whole
  and `null` clears it, and the record merge takes it from one writer like any other field. Every
  move goes through `translateStrip`, which carries the corners — moving only the ends once left a
  strip's corners where it had been. Versions before corners do exactly that, and draw a bent strip
  straight from start to end. The run, its centre (the middle of the box round its points) and the
  density fit all walk the legs: a fit grows the last leg, or drops the corners past its new end.
  On the plan a double-click on a leg adds a corner there and one on a corner removes it; corners
  snap level or plumb with their neighbours like the ends. In the 3D room each leg is its own tape
  with the LEDs shared out by length, so the pitch holds round a corner, and the strip stays one
  pickable whose legs are what a click hits and what the selection frames. "Onto the wall" is not
  offered for a bent strip; its corners are where the user put it.
- **Editor shortcuts stand aside for form fields.** The editor root owns Delete/Backspace, Cmd+Z,
  arrows and the rest, and the dock's fields sit inside it: Backspace in the on-canvas LED count
  deleted the strip, and Cmd+Z in a field ran the editor's undo instead of the field's own.
  `handleKeyDown` returns early for an input, textarea, select or contenteditable target
  (`shared/lib/editableTarget.ts`, the same test the global keybinds use). Space-to-pan has one
  owner too — `useRoomMapViewport` — with the canvas reading its `panMode` rather than keeping a
  second window listener that swallowed a space typed into any field.
- **The 3D room reads each piece's model from its size and its neighbours.** The stored types are
  a few words (`sofa`, `table`, `chair`, `bed`, `storage`, `plant`, `rug`, `kitchen`, `other`) and
  say little on their own, so the model is read the way a person reads a floor plan: a seat grows
  from a slipper chair through an armchair to a five-seat sofa with its width (one cushion per
  0.62 m between the arms); a table is a desk when the screen stands over it, the desk's return when
  it touches one, a coffee table in front of a sofa, a side table when small, else a dining table; a
  small chair at a desk is an office chair, a wide shallow one a bench; a kitchen piece about a
  fridge's footprint is the fridge, one deeper than 0.85 m the island, any other a counter run.
  Every part stays inside the
  footprint the 2D map gives the piece, at any size — the containment test runs each model at seven
  sizes, including a 3.81 × 0.17 m piece a user really drew. The reading lives in the three-free
  `room-view/model/furnitureModel.ts`, so the inspector can say what "Auto" reads as without the 3D
  chunk.
- **A monitor stands on its desk.** With no mount height of its own, a monitor over a desk is drawn
  on the desk's top (its stored height, else `DESK_TOP`) on a 10 cm stand, near the desk's back —
  the room's 40% default sank a wide monitor into the top and floated a small one on a pole. A set
  height is kept but never goes through the top. This is drawing only: room-aware sampling still
  reads `tvMountHeight`, so a monitor's light zones can sit a few centimetres off the drawn screen.
- **A user's pick overrides the reading; it never replaces it.** `FurniturePlacement.variant` (a
  table's desk/coffee/dining/side, a chair's dining/office/armchair/bench/stool/beanbag, a sofa's
  straight or corner, storage's sideboard/bookshelf/wardrobe/nightstand/TV unit/dresser, a kitchen's
  counter/island/fridge, a plant's habit, a rug's shape)
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
  The piece's own height is `topMeters` — `height` on this type is the footprint's depth. The TV
  inspector offers no field for it: it moved the screen off its wall and read as the screen's size.
  The screen is sized as it is sold, by its diagonal in inches or centimetres
  (`roomMapScreenUnit`), and `screenAspect` gives its shape; `width` stays what is stored, and a
  new diagonal or shape rewrites it about the screen's centre, since Hue sampling and the backlight
  match both read the screen from there. A width the room cannot hold is clamped, so a very wide
  pick reads back smaller. `screenKind` and `screenAspect` are the editor's alone: Rust receives
  them in the file it owns but never mirrors or projects them — `toRoomGeometry` copies the anchor
  field by field, and the shared parity fixture pins it. `resolveScreenKind` and `resolveFurnitureTop` read the two
  without a type's help, so a value from a newer build or a hand-edited file reads as absent. The
  model, tone, height and screen choices are offered only where the 3D room is built
  (`ROOM_VIEW_3D_AVAILABLE`): nothing stores what nothing draws. Their inspector edits carry a
  gesture key, because a chip or swatch group selects on every arrow key and each save re-applies
  the running mode.
- **The 3D room keeps its draw count fixed.** Furniture merges into one mesh per material by
  vertex colour, and what hangs on the ceiling into one more per material that casts no shadow —
  the house has no ceiling, so a canopy's shadow from the key light fell on the floor as a blot; the lamps' lit parts are one draw per shape (globe, drum shade, flared shade, bar —
  each mesh holds every lamp and shows only its own), floor pools and wall washes one draw each,
  whatever the lamp count;
  contact shadows are geometry with per-vertex alpha merged into one mesh — a stretched blur texture
  smeared on a long sofa — and include a soft band along the foot of every wall. The night backdrop
  is a CSS gradient behind a transparent canvas, so it costs no draw.
- **A pool or wash texture is written as data, never drawn.** three uploads a canvas with straight
  alpha, so WebKit un-premultiplies it; a canvas gradient is dithered in premultiplied space, and a
  texel whose colour came out one above its alpha wrapped past 255 to near 0 instead of clamping.
  Magnified over a pool, those texels were soft blobs tinted the lamp colour's complement with dark
  cores — in the app only, since Chromium clamps. `alphaTexture` in `scene/glow.ts` writes white
  texels with the alpha through `putImageData`; measured in a WKWebView, no texel drops below 254.
- **The lamps light the room; they are not painted on it.** The first six lamps in the room each get
  a real `PointLight` (`scene/lampLights.ts`), three of them casting a small cube shadow, and the
  evening rig — sky, key and fill — gives way to two rigs set far apart: a lamp-lit one, a warm
  bounce that takes a third of the lamps' colour (half as saturated for an effect, whose pure-RGB mean
  washed the wood teal), and a night one at a quarter of its sky under a cool moonlight key, so the
  lamps going out reads as the room going dark while its walls and floor still read. The lit rig once sat dimmer than a room with no
  lamps, and Off still showed a fully readable floor. The count is fixed,
  the spare lights dark, because three.js builds its shader programs for a number of lights: a count
  that followed the lamps recompiled the room on every added lamp. A lamp with a real light throws
  no painted wash and most of its pool — at the lights' strength the real light alone left dark
  wood an even brown with no pool under the lamp; one past the six keeps both. Their
  placeholder colour is one warm white — one rainbow colour per lamp read as a party, not a home.
  A one-sided fixture — a Play bar, a Signe, an Iris, a Bloom (`ONE_SIDED` in `scene/lamps.ts`) —
  lights only the side it faces, so it takes one of three `SpotLight`s instead and is drawn turned:
  its lit face, its body and its cone. With no facing stored it turns to the wall it stands nearest
  (`nearestWallFacing`), which is how these lights are set up in a room; a fourth falls back to a
  point light. Go, Iris and Bloom are three archetypes and three models, not one portable lamp.
  A light thrown straight down — a pendant, a downlight — reads nearly as well from a point, so the
  cones go to the sideways ones first.
- **A light at the ceiling is drawn as one that hangs there** (`scene/lamps.ts`). A spot at the
  ceiling is a downlight — a trim ring round a lens that stands proud of it, since the camera only
  ever sees the ceiling from above — and a bulb there hangs on a short cord from a socket. Both,
  and a pendant, throw their light down as a cone that shadows on one 2D map, and their floor pool
  is the cone's footprint rather than a lamp's wide wash. A light whose bottom is 1.2 m up or more
  shows, while selected or carried, a dashed plumb line to a ring on the floor under it
  (`scene/plumb.ts`): from above, a light in the air reads at any height until its floor point is
  drawn.
- **A Hue light's model and facing are the map's to override.** `HueChannelPlacement.fixture` draws
  a light as another fixture than its archetype names — the bridge only knows the bulb inside a
  lamp — and `facing` turns a one-sided one, in plan degrees clockwise from the TV wall (the
  plan's top), `FurniturePlacement.rotation`'s frame. Both are optional and absent means from the
  bridge and toward the nearest wall; both are drawing only, so neither reaches the stream or
  room-aware sampling, and both are read through `resolveHueFixture` / `resolveHueFacing`, which
  read a newer build's value as absent and leave it stored. Rust mirrors them without reading them,
  as it does `locked`: the zone commands echo the channel list back, and a field the mirror lacks
  is erased by every zone assignment (`a_zone_command_keeps_a_channels_facing_and_fixture`). The
  plan draws a one-sided light's facing as a wedge off its dot (`model/hueFacing.ts`), so the 2D
  and the 3D room agree on which way it points; the Edit face reads the bridge's archetypes too,
  for the inspector's "Auto · Play bar".
- **A light set down sits on what is there.** Moved on the plan — dragged, typed or carried in 3D —
  a Hue light that stood on the floor or a piece (within 15 cm of its top) goes on standing on the
  new surface the same distance up, and one the new piece would swallow rises onto its top
  (`model/lightSeat.ts`); one hung above both keeps its height. The 3D room already drew a lamp on
  the piece under it, but the stored height — which the stream and room-aware sampling read — was
  left at the floor until typed in. The inspector offers "Stand on {piece}" for a light over a piece
  it is not on.
- **A light chosen as a ceiling light goes up to where it hangs** (`model/hueHang.ts`). The 3D room
  draws a ceiling light on the ceiling and a pendant under it whatever the stored height says, and
  the stream samples the stored height, so a light set to Ceiling on the floor glowed overhead and
  was coloured as if at the floor. Choosing Ceiling or Pendant now moves it in the same undo step —
  the ceiling, or a shade 0.75 m below it — unless it hangs already or its zone stops short; a spot,
  or a bulb on nothing, is offered "Hang from the ceiling". The plan rings a light that hangs
  overhead in a dashed circle, as a reflected ceiling plan draws what is above the floor, and its
  name reads "— overhead".
- **The room's own build — columns, beams, windows, doors, niches, and the house's own ceiling
  lights — is `RoomMapConfig.structures`**,
  one list keyed on `kind` (`STRUCTURE_KINDS`), drawn in the plan and the 3D view and read by
  nothing else; Rust carries it through a Hue forget untouched (`forget.rs` pins it).
  `resolveRoomStructures` reads it and never writes: an unknown kind or a malformed entry is skipped
  for drawing and stays on disk, and a room resize shifts every stored entry's plan points, a
  newer build's kind included (`moveStructures`) — so every kind keeps its points in `x`/`y` or
  `x1`…`y2`, and no kind gives those names another meaning. A window, door or niche stores a point
  and a width, not a wall: the wall is read when it is drawn (`anchorWallItem`, the nearest wall it
  stands in front of, else the nearest by its ends, moved in so its width fits), so a reshaped room
  keeps it on a wall. A resize puts it back on the wall it was on: shifted with the room alone, an
  item on a wall pulled 3 m out was nearer the TV wall and jumped to it. A template lays out its own structures and Reset clears them, and a room with one
  is no longer empty. This pass draws them only; nothing picks, moves or adds one yet. In 3D, after
  the reference: a door is a real gap in its wall, with a lintel to the wall's top, a casing and a
  wooden leaf 30° open — at 12° and in slate it read as a shut door, the same dark as a pane — and
  the skirting and the foot shade stop at its jambs, a sill across it staying when the wall is cut;
  a window is a frame and a pane on the wall's face, dusk sky above and darker below, and the walls
  stand 15 cm above the tallest one, up to 85% of the ceiling, past which its head is cut — a hole
  in a wall standing lower than the window notched its top, which no reference frame shows; a
  niche is a back a shade darker with a shadow under its head and a ledge, since a box behind a
  10 cm wall would poke out of the room and lips round it read as a picture frame. What is on a cut
  wall's face hides with it (`spanHider`, the lift's own trick, so the draw count holds). A wall or
  column eases to its new height as the camera turns (`CUT_EASE_MS`, most of the way in 0.2 s) —
  snapping, it flickered while orbiting — and what is on its face goes as it starts down and
  returns once it stands again, since it cannot follow a merged mesh's scale. Columns
  stand at the walls' height, cast no shadow (the walls cast none, and a column's was the heaviest
  shape on the floor) and are cut only in the camera's line to the room — cut for being on the near
  side, one read as a stool; a beam rests on the walls' tops and goes once every wall it rests on
  is cut. The plan draws them as a plan does: glass across the wall line, a door's gap, leaf and
  dashed swing, a niche dashed behind the wall, a column solid, a beam dashed overhead, a ceiling
  light a dashed ring with a cross. A ceiling light (`kind: "light"`, `DECOR_LIGHT_FIXTURES`) is
  one of the house's, not a Hue light: never streamed and no channel. It is an object of its own
  (`decor-<id>`, `model/decorLight.ts`): picked and carried in Edit, on the plan and in 3D, as a Hue
  light is, with a card for where it is, how it hangs (`dropMeters`) and its fixture. The card's
  "Drive with a Hue light" moves the chosen channel onto it — position, height and fixture through
  the channel's own helpers, out of a zone the lamp is not in — and removes it, in one patch, so one
  undo puts both back. It has no delete or duplicate: a template lays it out. In 3D it is a Hue
  lamp's fixture glowing in its own white (`kelvin`, 2700 K by default) at a fixed level whatever
  the mode — Off darkens what LumaSync drives, not the house's lights — and it takes glow only,
  after the Hue lamps: no real light (the six are the Hue lights'), and it leaves the room's rig
  alone, so a room with only these keeps the evening one. By a wall a floor pool moves in up to
  40 cm and then narrows to stay on the floor, and a wall wash stays under the cut walls' top: both
  hung past the room's edge onto the backdrop, and narrowed alone a light on the wall lost its pool.
  A light thrown straight down washes no wall — washed, a downlight read as a sconce — and a flush
  ceiling light's diffuser stands proud of its rim, which hid it from a camera always above. The
  readers live in `contracts/roomStructureResolver.ts`, apart from the types: `roomMap.ts` is in the
  entry chunk, and only the lazy room map and 3D view read structures.
- **The running mode sets the room's mood.** `roomMood` (`room-view/model/roomMood.ts`) reads what
  runs from the lighting control state: Off leaves the lamps dark — the rig falls to the unlit room (below),
  the bulbs to frosted glass, the TV's backlight out; Solid lights every lamp in
  its colour at its brightness, never below a floor so 1% still glows; an effect spreads its palette
  over the room, lamp *i* and strip *i* taking stop *i* mod *n*, the sky and the backlight from the
  stops' mean, and the dock's discs draw the palette (the mean of a rainbow is a grey that read as
  off) — one middle colour for every lamp had made Effect indistinguishable from Solid white, and
  with no effect chosen yet the room plays the default one, as the contract reads it; Ambilight dims the room to a cinema violet, its lamps low and cool — what a screen throws
  into a dark room — until the live colours reach the view. Three levels move apart: the lamps, the
  room's own light, and the strips with the screen's backlight. The room's light followed the lamps
  once, and every mode washed the whole room in its colour; now an effect lights the room at about
  half its lamps, Ambilight at a quarter, while the strips and the backlight — what carries the
  picture — stay at the brightness the user set. The backlight throws a rim around the screen, not
  a round pool. The sky is two registered custom
  properties on the stage (`--lm-room-sky-top`, `--lm-room-sky-mid`), so a change eases the CSS
  gradient, and the lamps ease over 900 ms without rebuilding the scene (`RoomScene.setMood`). The
  colours stay placeholders where the live feed is the truth (Ambilight, an effect's motion) until it
  reaches the view.
- **How lit the unlit room is is the user's** — the sun value in the corner over the 3D room, in
  View and on Edit's 3D stage (`RoomDaylight`), night (0) to day (100); it sat in Room settings at
  first, which View cannot open, and was not found there. Stored as `roomMapAmbient`, a whole percent (default 35). An unlit room has no one right
  brightness: full night hid the room and its dark lamps, a fixed bright one made a room with its
  lights off read as lit. The default lands on a dusk where both still read; past it the rig and sky
  move toward a neutral day, and under it toward the moonlit night Off once always was. A room with
  no lamps keeps its evening rig at the default. Lit lamps keep their say — a fully lit room's sky does
  not change, a dimmer one gives way to the day by how dim it is, and at full day the rig is still
  half the lamps' — so the setting mostly reads with
  the lights off or dim. It eases with the lamps (`daylight` is a `MoodLevels` level), follows the
  thumb in this window and is saved where it is let go (`previewPreference`), so a drag is one write.
- **The camera travels to what is picked.** A light or the screen picked in the room or the dock
  draws the camera most of the way to it at once and then settles (760 ms, an exponential ease-out),
  framed 1.55× closer with its middle 70% of the way from the room's centre to the light, so the
  light sits in its corner of the room rather than alone. Clearing the pick travels back to where the
  camera was; turning or zooming by hand in between (OrbitControls' `start`) forgets the way back, so
  a view the user set is never taken from them. A piece of furniture picked to be carried does not
  move the camera. Over a light or the screen the pointer shows a chip with its name and whether it
  is lit (`HoverChip`), placed by transform so following the pointer re-renders nothing; it is
  `aria-hidden`, the dock listing the same lights with their state.
- **The glow comes from the bulbs alone.** `scene/bloom.ts` draws the room a second time at half
  resolution with every material black but the bulbs (`BLOOM_LAYER`), blurs that and adds it over
  the room, so a sofa in front of a lamp still hides its glow. A brightness threshold could not pick
  the bulbs out: a wall a hand from a lamp is lit brighter than the bulb is drawn, and the whole room
  hazed. The canvas stays transparent, the glow's alpha following its light, so a halo past the
  room's edge lands on the backdrop as light. Screenshots of the view from a hidden headless page
  catch the canvas's fade-in half done — the whole room looks veiled — so the capture forces it
  opaque; the veil is not in the app.
- **Bare keys belong to the canvas; modified ones to the whole editor.** Arrows, Delete/Backspace,
  R and Escape act only when the event comes from the editor root or from inside the
  `data-room-map-viewport` element. On a dock tile, a segmented control or a menu item an arrow moved
  the selection along with the control, and Delete removed the selected object. Cmd/Ctrl+Z, +D and
  +0 stay editor-wide. The window-wide Space listener also leaves a button, tab, radio or menu item
  alone, because Space is how those are pressed. A right-click opens the plan's menu only inside the
  viewport: a popover's right-click reaches the editor root through the React tree from its portal.

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
