# Room map

A top-down editor for where the lights physically are: the room footprint, the TV, furniture, USB
strip runs, and Hue channel dots. Most users never open it — first run reaches working ambient
lighting without it — but everything authored here feeds the runtime sampler, so the coordinate
rules below are load-bearing rather than cosmetic.

The module is `src/features/room-map/`; `RoomMapEditor.tsx` is its entry point and the largest
single piece of UI in the codebase.

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

**A zone is a physical square in metres, which means its two cube-space scales diverge in a
non-square room.** The inspector edits one edge length; `scaleX` and `scaleY` are derived from it
against the room's width and depth independently, so a 1 m square in a 5×4 m room is not a uniform
fraction of the bridge's ±1 frame. Patches therefore pass through verbatim rather than mirroring one
axis onto the other, and Rust validates each axis on its own against the `HUE_ZONE_SCALE_MIN` /
`HUE_ZONE_SCALE_MAX` band and the cube-overflow invariant
(`src-tauri/src/commands/room_map/hue_zone.rs`). The frontend mirrors that band as a clamp; the two
constants have to move together.

## Gotchas

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
