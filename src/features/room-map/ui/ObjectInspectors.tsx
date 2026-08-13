/**
 * ObjectInspectors — type-aware inspector components rendered inside
 * `RoomDockPanel` when an object (or legacy zone) is the active selection.
 *
 * Why this file exists (Wave 4-D rework):
 * --------------------------------------
 * Before W4-D the dock had four tabs (Objects / Zones / Hue Zones /
 * **Properties**) and the Properties tab simply rendered an empty
 * "pick something" hint — the tab itself never carried unique content
 * because the same inspector was already mounted in the bottom half of
 * the dock body (split-pane layout). The user feedback ("prop tabı ne
 * yapıyor anlamadım gereksiz gibi") confirmed the redundancy.
 *
 * Resolution: the Properties tab is dropped, and the inspector below
 * the tab list now swaps **type-specific** components based on what is
 * selected. Each inspector surfaces the controls that matter for its
 * type — instead of every selection routing the user to the generic
 * X/Y/W/H/R PropertyBar at the bottom of the editor.
 *
 * Inspectors re-exported here (one file each, under `objects/`):
 *   - `FurnitureInspector`     — name (rename), type, rotation, lock
 *   - `TvAnchorInspector`      — physical width/height in metres, lock
 *   - `UsbStripInspector`      — LED count, linked port + connection
 *                                status badge (Wave 4-E surface), lock,
 *                                "Disconnect" affordance
 *   - `HueChannelInspector`    — channel index, parent zone, label,
 *                                world coords (read-only summary)
 *   - `ImageLayerInspector`    — opacity slider + reset
 *   - `LegacyZoneInspector`    — channel count + assign hint
 *
 * `HueZoneInspector` lives in its own file (W4-C surface, untouched).
 *
 * Composition rules:
 * ------------------
 * - Every inspector sits inside the existing `lm-room-dock-inspect`
 *   container — it does not own the outer chrome. Each renders an
 *   `lm-room-dock-inspect-h` header (chip + name) and a stack of
 *   `lm-room-dock-field` rows.
 * - Tap targets ≥ 32 px (slider thumbs already 12 px, but interactive
 *   buttons clear the floor via `min-height: 32px`).
 * - Reduced-motion + forced-colors fall back to the inherited dock
 *   styles in `styles.css`; no new transitions defined here.
 * - 100 % localised — every visible string goes through `t()`.
 */
export { FurnitureInspector } from "./objects/FurnitureInspector";
export { HueChannelInspector } from "./objects/HueChannelInspector";
export { ImageLayerInspector } from "./objects/ImageLayerInspector";
export { TvAnchorInspector } from "./objects/TvAnchorInspector";
export {
  UsbStripInspector,
  type UsbStripConnectionStatus,
} from "./objects/UsbStripInspector";
