import { memo, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";
import { findHueChannel } from "@/shared/contracts/roomMap";
import { clamp } from "@/shared/lib/math";
import { hueChannelObjectId } from "../model/objectId";
import { findBoundZone, hueToMetres, hueToPlanMetres, planMetresToHue, resolveHueChannelWorld } from "../model/hueChannelPosition";
import type { SnapResult } from "../model/snapGeometry";
import { hueChannelDotText, hueChannelName } from "../model/hueChannelLabel";
import { fanOutStacked } from "../model/stackFan";
import { markDragging, pastSlop, useEscapeCancels } from "./objects/dragIntent";
import { ZoneResizeHandles } from "./ZoneResizeHandles";
import { cx } from "@/shared/lib/cx";

interface HueChannelOverlayProps {
  channels: HueChannelPlacement[];
  /** A one-sided light's facing in plan degrees (0 toward the TV wall), drawn as a beam off its dot. */
  facings?: ReadonlyMap<number, number>;
  /** Channels that hang overhead, drawn in a dashed ring as a ceiling plan draws what is above. */
  overhead?: ReadonlySet<number>;
  pxPerMeter: number;
  roomWidthM: number;
  roomDepthM: number;
  zoom?: number;
  selectedId: string | null;
  onSelect: (channelIndex: number) => void;
  onChange: (updated: HueChannelPlacement) => void;
  /** When true, space is held — don't start drag */
  panMode?: boolean;
  /** Bridge ids the area reports, or `null`/absent when no clean read has
   *  landed. A placement outside a non-null set is drawn as a ghost; `null`
   *  marks nothing, because "cannot tell" is not "everything is gone". */
  liveChannelIds?: ReadonlySet<number> | null;
  /**
   * When set, the overlay enters "Hue zone scope" mode:
   * - Channels bound to this zone render at zone-relative coordinates
   *   resolved against the zone's center+scale.
   * - Channels NOT in the zone render greyed out and pointer-disabled.
   * - The zone center marker + bounds box are drawn behind the channels.
   * - Drag updates emit `zoneRelativePosition` (and the absolute fields
   *   are kept consistent so legacy consumers still work).
   */
  activeHueZone?: HueZone | null;
  /** Called when the user drags the zone center marker. */
  /** `held` for a key's run of steps, which is one undo step. */
  onHueZoneCenterChange?: (zoneId: string, centerX: number, centerY: number, held?: boolean) => void;
  /** The lights' colour and level while they are on, as the room view draws them; absent while off. */
  glow?: { colour: string; level: number } | null;
  /** Lines a dragged light up with the room's pieces and its other lights; ⌥ drags it free. */
  onSnapDragMove?: (id: string, x: number, y: number, w: number, h: number) => SnapResult;
  onSnapDragEnd?: () => void;
  /** Called once when a grip on the active zone's bounds is let go. */
  onHueZoneResize?: (zoneId: string, footprint: Pick<HueZone, "centerX" | "centerY" | "scaleX" | "scaleY">) => void;
  /**
   * When supplied, every zone in the array renders its
   * dashed bounds box on the canvas (not just the active one). Passive
   * zones render dimmer and without the center-drag handle so they
   * cannot be accidentally moved while selecting elsewhere; the active
   * zone (if any) keeps its full chrome and is matched by id so the
   * drag-time DOM lookup (`data-zone-bounds-id`) still resolves a
   * single element.
   *
   * This list also drives the
   * channel-bound zone lookup used by the drag handler and the world-
   * pos derivation, so it MUST stay populated even when the user
   * toggles the dashed-bounds visibility off. Pair this with the
   * `hidePassiveZoneBounds` flag below to hide the dashed boxes for
   * non-active zones without breaking the channel zone-binding.
   */
  allHueZones?: HueZone[];
  /**
   * When true, suppress the dashed bounds-box rendering for every
   * zone except the active one. Channel positions are still resolved
   * through their bound zone via `allHueZones` — only the visual
   * outline is hidden.
   */
  hidePassiveZoneBounds?: boolean;
}

/**
 * Project a world-space Hue coordinate into the active zone's bounds.
 *
 * A channel drag must never escape the parent zone box. Pipeline:
 *   1. Clamp world to `[-1, 1]` (Hue cube, the bridge cap).
 *   2. Invert through the zone transform → relative space.
 *   3. Clamp relative to `[-1, 1]` (zone box).
 *   4. Re-project to world via `center + scale * relative`.
 *
 * Returns both the bounded world tuple and the matching zone-relative
 * coordinates so the drag handler can persist them in one shot. A zero
 * `scale*` (a degenerate zone) is taken as 1 to avoid a divide-by-zero.
 */
function clampWithinZone(
  worldX: number,
  worldY: number,
  zone: HueZone,
): { worldX: number; worldY: number; relX: number; relY: number } {
  const wx = clamp(worldX, -1, 1);
  const wy = clamp(worldY, -1, 1);
  const sx = zone.scaleX === 0 ? 1 : zone.scaleX;
  const sy = zone.scaleY === 0 ? 1 : zone.scaleY;
  const relX = clamp((wx - zone.centerX) / sx, -1, 1);
  const relY = clamp((wy - zone.centerY) / sy, -1, 1);
  return {
    worldX: clamp(zone.centerX + sx * relX, -1, 1),
    worldY: clamp(zone.centerY + sy * relY, -1, 1),
    relX,
    relY,
  };
}

/** `allHueZones` is canonical, but an embed may pass only the active zone —
 *  keep resolving through it so a bound channel does not fall back to `ch.x/y`. */
function withActiveZone(
  zones: readonly HueZone[],
  active: HueZone | null | undefined,
): readonly HueZone[] {
  return active && !zones.some((z) => z.id === active.id) ? [...zones, active] : zones;
}

interface DragState {
  active: boolean;
  channelIndex: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  currentRelX: number | null;
  currentRelY: number | null;
  element: HTMLDivElement | null;
  /** Past the slop: a press that never got there is a click and moves nothing. */
  moved: boolean;
  /** Where the dot's wrapper was drawn at the press, for Esc to put it back. */
  homeLeft: string;
  homeTop: string;
}

const EMPTY_DRAG: DragState = {
  active: false,
  channelIndex: -1,
  startClientX: 0,
  startClientY: 0,
  startX: 0,
  startY: 0,
  currentX: 0,
  currentY: 0,
  currentRelX: null,
  currentRelY: null,
  element: null,
  moved: false,
  homeLeft: "",
  homeTop: "",
};

/** Which walls the zone box is flush against. Exported for tests: the drag path
 *  is imperative DOM, the decision is arithmetic. A degenerate zone (half-scale
 *  past 1) already overflows the cube, so it reports nothing rather than all four. */
export function pinnedZoneEdges(
  center: { centerX: number; centerY: number },
  scale: { halfScaleX: number; halfScaleY: number },
): string {
  const { halfScaleX, halfScaleY } = scale;
  // Tolerant, not `===`: the drag path compares a value against the very bound
  // `clamp` returned so it would match exactly, but a centre that has been
  // round-tripped through the backend carries float noise, and `-1 + 0.6` is
  // not `-0.4`. Exact equality would silently stop lighting the edge.
  const atWall = (value: number, bound: number) => Math.abs(value - bound) <= 1e-6;
  const edges: string[] = [];
  if (halfScaleY <= 1) {
    if (atWall(center.centerY, 1 - halfScaleY)) edges.push("top");
    if (atWall(center.centerY, -1 + halfScaleY)) edges.push("bottom");
  }
  if (halfScaleX <= 1) {
    if (atWall(center.centerX, -1 + halfScaleX)) edges.push("left");
    if (atWall(center.centerX, 1 - halfScaleX)) edges.push("right");
  }
  return edges.join(" ");
}

/**
 * Renders Hue channel dots on the room map canvas.
 *
 * Positions are computed in pixels (pxPerMeter * room metres) so they stay
 * aligned with all other room objects regardless of panel open/close resizing.
 */
/** Cube units an arrow key moves a zone centre; with Shift, the larger step. */
const ZONE_CENTER_KEY_STEP = 0.05;
const ZONE_CENTER_KEY_STEP_LARGE = 0.2;
/** Hue +y is the TV wall, the top of the canvas. */
const ARROW_DELTAS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: 1 },
  ArrowDown: { x: 0, y: -1 },
};

/** Keeps the whole zone box (centre ± half-scale) inside the Hue cube, so the bounds never
 *  overflow the room map. A degenerate zone wider than the cube falls back to the plain world
 *  clamp, so the marker still follows the pointer. */
function clampZoneCenter(cx: number, cy: number, halfScaleX: number, halfScaleY: number) {
  return {
    x: halfScaleX > 1 ? clamp(cx, -1, 1) : clamp(cx, -1 + halfScaleX, 1 - halfScaleX),
    y: halfScaleY > 1 ? clamp(cy, -1, 1) : clamp(cy, -1 + halfScaleY, 1 - halfScaleY),
  };
}

export const HueChannelOverlay = memo(function HueChannelOverlay({
  channels,
  liveChannelIds,
  pxPerMeter,
  roomWidthM,
  roomDepthM,
  zoom = 1,
  selectedId,
  onSelect,
  onChange,
  panMode = false,
  activeHueZone = null,
  onHueZoneCenterChange,
  onHueZoneResize,
  onSnapDragMove,
  onSnapDragEnd,
  glow = null,
  allHueZones,
  hidePassiveZoneBounds = false,
  facings,
  overhead,
}: HueChannelOverlayProps) {
  const { t } = useTranslation();

  const dragRef = useRef<DragState>({ ...EMPTY_DRAG });

  const channelsRef = useRef(channels);
  channelsRef.current = channels;

  const ppmRef = useRef(pxPerMeter);
  ppmRef.current = pxPerMeter;
  const widthRef = useRef(roomWidthM);
  widthRef.current = roomWidthM;
  const depthRef = useRef(roomDepthM);
  depthRef.current = roomDepthM;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const snapRef = useRef({ move: onSnapDragMove, end: onSnapDragEnd });
  snapRef.current = { move: onSnapDragMove, end: onSnapDragEnd };

  const activeHueZoneRef = useRef(activeHueZone);
  activeHueZoneRef.current = activeHueZone;

  // An undo or a refusal can take the zone away mid-drag; its window listener must not outlive it.
  const zoneDragLive = useRef<(() => void) | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the zone's id is the trigger.
  useEffect(() => () => zoneDragLive.current?.(), [activeHueZone?.id]);

  // The full list, not just the active zone — the drag handler must resolve
  // `ch.zoneId` for passive zones too. See docs/architecture/room-map.md.
  const allHueZonesRef = useRef(allHueZones ?? []);
  allHueZonesRef.current = allHueZones ?? [];

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, ch: HueChannelPlacement, fan?: { dx: number; dy: number }) => {
      if (panMode) return;
      e.stopPropagation();
      onSelect(ch.channelIndex);
      if (ch.locked) return;
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);

      // From where the dot is drawn, not `ch.x/y`: for a bound channel those are
      // leftovers a zone move or an assignment never updated, and the drag
      // jumped the dot to them.
      const drawn = resolveHueChannelWorld(
        ch,
        withActiveZone(allHueZonesRef.current, activeHueZoneRef.current),
      );
      // A light fanned out of a stack is dragged from where it is drawn, so it lands where it is let go.
      const start = fan
        ? {
            x: clamp(drawn.x + (fan.dx / ppmRef.current / widthRef.current) * 2, -1, 1),
            y: clamp(drawn.y - (fan.dy / ppmRef.current / depthRef.current) * 2, -1, 1),
          }
        : drawn;

      dragRef.current = {
        active: true,
        channelIndex: ch.channelIndex,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startX: start.x,
        startY: start.y,
        currentX: start.x,
        currentY: start.y,
        currentRelX: ch.zoneRelativePosition?.x ?? null,
        currentRelY: ch.zoneRelativePosition?.y ?? null,
        element: el,
        moved: false,
        homeLeft: el.parentElement?.style.left ?? "",
        homeTop: el.parentElement?.style.top ?? "",
      };
    },
    [onSelect, panMode],
  );

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const dr = dragRef.current;
    if (!dr.active) return;
    // A click's wobble moved the light and wrote it back to the bridge.
    if (!dr.moved && !pastSlop(dr.startClientX, dr.startClientY, e.clientX, e.clientY)) return;
    if (!dr.moved) {
      dr.moved = true;
      markDragging(dr.element?.parentElement, true);
    }

    const effectivePpm = ppmRef.current * zoomRef.current;
    const dxPx = e.clientX - dr.startClientX;
    const dyPx = e.clientY - dr.startClientY;

    // Convert pixel delta to Hue coordinate delta
    const dxHue = (dxPx / effectivePpm) / widthRef.current * 2;
    // Y inverted: CSS down = Hue y decrease
    const dyHue = -(dyPx / effectivePpm) / depthRef.current * 2;

    let newX = clamp(dr.startX + dxHue, -1, 1);
    let newY = clamp(dr.startY + dyHue, -1, 1);
    let relX: number | null = null;
    let relY: number | null = null;

    // Clamp through the bound zone on every drag, selected or not — see
    // docs/architecture/room-map.md. `allHueZones` is canonical; the fallback to
    // `activeHueZone` covers callers that do not pass the full list.
    const ch = findHueChannel(channelsRef.current, dr.channelIndex);
    const boundZone = ch
      ? findBoundZone(ch, withActiveZone(allHueZonesRef.current, activeHueZoneRef.current))
      : null;
    if (boundZone) {
      const bounded = clampWithinZone(newX, newY, boundZone);
      newX = bounded.worldX;
      newY = bounded.worldY;
    }
    // Snapped where the zone has put it, and kept only if the guide lies inside the zone too.
    const snapMove = snapRef.current.move;
    if (snapMove) {
      const at = hueToPlanMetres({ x: newX, y: newY }, widthRef.current, depthRef.current);
      const snap = snapMove(hueChannelObjectId(dr.channelIndex), at.x, at.y, 0, 0);
      if (!e.altKey && (snap.snapX !== null || snap.snapY !== null)) {
        const held = planMetresToHue(snap.snapX ?? at.x, snap.snapY ?? at.y, widthRef.current, depthRef.current);
        const inside = boundZone ? clampWithinZone(held.x, held.y, boundZone) : null;
        if (!inside || (Math.abs(inside.worldX - held.x) < 1e-9 && Math.abs(inside.worldY - held.y) < 1e-9)) {
          newX = clamp(held.x, -1, 1);
          newY = clamp(held.y, -1, 1);
        } else {
          snapRef.current.end?.();
        }
      }
    }
    if (boundZone) {
      const bounded = clampWithinZone(newX, newY, boundZone);
      relX = bounded.relX;
      relY = bounded.relY;
    }

    dr.currentX = newX;
    dr.currentY = newY;
    dr.currentRelX = relX;
    dr.currentRelY = relY;

    // Imperative, to avoid a re-render per move. The NaN guards mirror the
    // render path — this bypasses it, so it does not inherit them.
    const wrapper = dr.element?.parentElement;
    if (wrapper) {
      const rawLeft = hueToMetres(newX, widthRef.current) * ppmRef.current;
      const rawTop = hueToMetres(-newY, depthRef.current) * ppmRef.current;
      const leftPx = Number.isFinite(rawLeft) ? rawLeft : 0;
      const topPx = Number.isFinite(rawTop) ? rawTop : 0;
      wrapper.style.left = `${leftPx}px`;
      wrapper.style.top = `${topPx}px`;
    }
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const dr = dragRef.current;
    if (!dr.active) return;

    e.currentTarget.releasePointerCapture(e.pointerId);
    markDragging(dr.element?.parentElement, false);
    snapRef.current.end?.();

    const ch = findHueChannel(channelsRef.current, dr.channelIndex);
    if (ch && dr.moved && (dr.currentX !== dr.startX || dr.currentY !== dr.startY)) {
      // Write-back is zone-relative for ANY bound channel, not just the active
      // one — the third of the three paths that must agree on the parent zone.
      // `handlePointerMove` already clamped the values into `dragRef`.
      const boundZone = findBoundZone(
        ch,
        withActiveZone(allHueZonesRef.current, activeHueZoneRef.current),
      );
      if (boundZone && dr.currentRelX !== null && dr.currentRelY !== null) {
        onChangeRef.current({
          ...ch,
          x: dr.currentX,
          y: dr.currentY,
          zoneRelativePosition: {
            x: dr.currentRelX,
            y: dr.currentRelY,
            z: ch.zoneRelativePosition?.z ?? 0,
          },
        });
      } else {
        onChangeRef.current({ ...ch, x: dr.currentX, y: dr.currentY });
      }
    }

    dragRef.current = { ...EMPTY_DRAG };
  }, []);

  // Esc, or the system taking the pointer, puts the dot back where it was drawn and writes nothing.
  const cancelDrag = useCallback(() => {
    const dr = dragRef.current;
    if (!dr.active) return;
    const wrapper = dr.element?.parentElement;
    markDragging(wrapper, false);
    snapRef.current.end?.();
    if (wrapper && dr.moved) {
      wrapper.style.left = dr.homeLeft;
      wrapper.style.top = dr.homeTop;
    }
    dragRef.current = { ...EMPTY_DRAG };
  }, []);
  useEscapeCancels(() => dragRef.current.active, cancelDrag);

  // ── Zone bounds + center marker (rendered behind channels) ──
  // Factored into a helper so we can render bounds for *any*
  // zone (passive list) using the same projection math.
  const computeZoneBoundsBox = (zone: HueZone) => {
    const minX = clamp(zone.centerX - Math.abs(zone.scaleX), -1, 1);
    const maxX = clamp(zone.centerX + Math.abs(zone.scaleX), -1, 1);
    const minY = clamp(zone.centerY - Math.abs(zone.scaleY), -1, 1);
    const maxY = clamp(zone.centerY + Math.abs(zone.scaleY), -1, 1);
    const leftPx = hueToMetres(minX, roomWidthM) * pxPerMeter;
    const rightPx = hueToMetres(maxX, roomWidthM) * pxPerMeter;
    // Y flip: CSS y grows downward, and Hue +y (the TV wall) is drawn at the canvas top.
    const topPx = hueToMetres(-maxY, roomDepthM) * pxPerMeter;
    const bottomPx = hueToMetres(-minY, roomDepthM) * pxPerMeter;
    const centerLeftPx = hueToMetres(zone.centerX, roomWidthM) * pxPerMeter;
    const centerTopPx = hueToMetres(-zone.centerY, roomDepthM) * pxPerMeter;
    const color = zone.borderColor ?? "var(--lm-zone-1)";
    return { leftPx, rightPx, topPx, bottomPx, centerLeftPx, centerTopPx, color };
  };
  const zoneBoundsBox = activeHueZone ? computeZoneBoundsBox(activeHueZone) : null;
  // Passive zones render dimmer and without the centre handle. Matched by id,
  // so the drag-time `[data-zone-bounds-id=...]` lookup stays single-element.
  const passiveZones = hidePassiveZoneBounds
    ? []
    : (allHueZones ?? []).filter(
        (z) => !activeHueZone || z.id !== activeHueZone.id,
      );

  const resolvableZones = withActiveZone(allHueZones ?? [], activeHueZone);
  const placed = channels.map((ch) => {
    // Render from zone-relative coords for any bound channel: the absolute
    // `ch.x/y` is stale leftover and passive zones would visibly drift.
    const { x: worldX, y: worldY } = resolveHueChannelWorld(ch, resolvableZones);
    // NaN has real sources here (failed mid-drag invoke, `pxPerMeter` 0 at
    // mount) and React would stamp it into `style.left`. See room-map.md.
    const rawLeftPx = hueToMetres(worldX, roomWidthM) * pxPerMeter;
    // Invert Y: CSS y grows downward; Hue +y (the TV wall) is the canvas top.
    const rawTopPx = hueToMetres(-worldY, roomDepthM) * pxPerMeter;
    return {
      ch,
      leftPx: Number.isFinite(rawLeftPx) ? rawLeftPx : 0,
      topPx: Number.isFinite(rawTopPx) ? rawTopPx : 0,
    };
  });
  // In layer pixels, which the plan scales by `zoom`: divided by it, the fan keeps its size on screen.
  const fans = fanOutStacked(
    placed.map((p) => ({ id: p.ch.channelIndex, x: p.leftPx, y: p.topPx })),
    { near: 10 / zoom, radius: 16 / zoom, spacing: 22 / zoom },
  );

  return (
    <>
      {/* Passive zone bounds (read-only). Sits behind the
          active zone chrome so the active dashed border stays visually
          dominant. No center marker, no drag wiring, no chip — just the
          rectangle so the user can see where each zone lives. */}
      {passiveZones.map((zone) => {
        const box = computeZoneBoundsBox(zone);
        return (
          <div
            key={`passive-zone-${zone.id}`}
            className="pointer-events-none absolute rounded"
            style={{
              left: box.leftPx,
              top: box.topPx,
              width: box.rightPx - box.leftPx,
              height: box.bottomPx - box.topPx,
              border: `1px dashed color-mix(in srgb, ${box.color} 35%, transparent)`,
              background: `color-mix(in srgb, ${box.color} 1.5%, transparent)`,
              zIndex: 17,
              opacity: 0.6,
            }}
            aria-hidden
          />
        );
      })}
      {/* Zone bounds box + center marker — only when a Hue zone is active */}
      {activeHueZone && zoneBoundsBox && (
        <>
          {/* Zone label chip — pinned at bounds top-left so the user can
              read the active zone name at a glance even when the dashed
              border is faint or partially off-screen. */}
          <div
            data-zone-chip-id={activeHueZone.id}
            className="lm-room-zone-chip"
            // Screen-sized like the dots: at a high zoom the chip grew with the plan.
            style={{
              left: Math.max(8 / zoom, zoneBoundsBox.leftPx + 6 / zoom),
              top: Math.max(8 / zoom, zoneBoundsBox.topPx - 22 / zoom),
              transform: `scale(${1 / zoom})`,
              transformOrigin: "0 0",
            }}
            aria-hidden
          >
            <span
              className="lm-room-zone-chip-dot"
              style={{ background: zoneBoundsBox.color }}
            />
            <span>{activeHueZone.name}</span>
            <span className="lm-room-zone-chip-tip">
              {t("roomMap:hueZones.activeChipTip")}
            </span>
          </div>
          <div
            data-zone-bounds-id={activeHueZone.id}
            className="pointer-events-none absolute rounded"
            style={{
              left: zoneBoundsBox.leftPx,
              top: zoneBoundsBox.topPx,
              width: zoneBoundsBox.rightPx - zoneBoundsBox.leftPx,
              height: zoneBoundsBox.bottomPx - zoneBoundsBox.topPx,
              // Soft: the label chip carries the zone's identity; the outline only has to hold the grips.
              border: `1px dashed color-mix(in srgb, ${zoneBoundsBox.color} 80%, transparent)`,
              background: `color-mix(in srgb, ${zoneBoundsBox.color} 6%, transparent)`,
              zIndex: 18,
            }}
            aria-hidden
          >
            {onHueZoneResize && (
              <ZoneResizeHandles
                zone={activeHueZone}
                widthM={roomWidthM}
                depthM={roomDepthM}
                pxPerMeter={pxPerMeter}
                zoom={zoom}
                panMode={panMode}
                onResize={onHueZoneResize}
              />
            )}
          </div>
          <div
            role="button"
            tabIndex={0}
            data-zone-center-id={activeHueZone.id}
            aria-label={t("roomMap:hueZones.centerMarkerAriaLabel", { name: activeHueZone.name })}
            title={t("roomMap:hueZones.centerMarkerAriaLabel", { name: activeHueZone.name })}
            className="absolute flex h-3 w-3 cursor-grab items-center justify-center rounded-full ring-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            style={{
              left: zoneBoundsBox.centerLeftPx,
              top: zoneBoundsBox.centerTopPx,
              transform: "translate(-50%, -50%)",
              background: zoneBoundsBox.color,
              boxShadow: `0 0 0 2px rgba(0,0,0,0.4), 0 0 0 4px ${zoneBoundsBox.color}`,
              zIndex: 19,
              touchAction: "none",
            }}
            onKeyDown={(e) => {
              const step = e.shiftKey ? ZONE_CENTER_KEY_STEP_LARGE : ZONE_CENTER_KEY_STEP;
              const delta = ARROW_DELTAS[e.key];
              if (!delta || !onHueZoneCenterChange) return;
              // The editor's own arrow keys would also nudge the selection or pan the map.
              e.preventDefault();
              e.stopPropagation();
              const next = clampZoneCenter(
                activeHueZone.centerX + delta.x * step,
                activeHueZone.centerY + delta.y * step,
                Math.abs(activeHueZone.scaleX),
                Math.abs(activeHueZone.scaleY),
              );
              if (next.x !== activeHueZone.centerX || next.y !== activeHueZone.centerY) {
                onHueZoneCenterChange(activeHueZone.id, next.x, next.y, true);
              }
            }}
            onPointerDown={(e) => {
              if (panMode || !onHueZoneCenterChange) return;
              e.stopPropagation();
              const target = e.currentTarget;
              target.setPointerCapture(e.pointerId);
              const startCx = activeHueZone.centerX;
              const startCy = activeHueZone.centerY;
              const startClientX = e.clientX;
              const startClientY = e.clientY;
              const effectivePpm = ppmRef.current * zoomRef.current;
              const zoneId = activeHueZone.id;
              const halfScaleX = Math.abs(activeHueZone.scaleX);
              const halfScaleY = Math.abs(activeHueZone.scaleY);

              // The bounds box AND every dot bound to this zone
              // have to follow the centre. See docs/architecture/room-map.md.
              const overlayRoot = target.parentElement;
              const boundsEl = overlayRoot?.querySelector<HTMLDivElement>(
                `[data-zone-bounds-id="${zoneId}"]`,
              );
              const boundsStart = boundsEl
                ? {
                    left: parseFloat(boundsEl.style.left || "0"),
                    top: parseFloat(boundsEl.style.top || "0"),
                  }
                : null;
              const boundChannelEls = overlayRoot
                ? Array.from(
                    overlayRoot.querySelectorAll<HTMLDivElement>(
                      `[data-zone-channel-id="${zoneId}"]`,
                    ),
                  )
                : [];
              const channelStarts = boundChannelEls.map((el) => ({
                el,
                left: parseFloat(el.style.left || "0"),
                top: parseFloat(el.style.top || "0"),
              }));

              // A press left over from the last drag must not read as this one's end.
              delete target.dataset.cx;
              delete target.dataset.cy;
              const markerStart = { left: target.style.left, top: target.style.top };
              let moved = false;
              const moveHandler = (mv: PointerEvent) => {
                if (!moved && !pastSlop(startClientX, startClientY, mv.clientX, mv.clientY)) return;
                moved = true;
                const dxPx = mv.clientX - startClientX;
                const dyPx = mv.clientY - startClientY;
                const dxHue = (dxPx / effectivePpm) / widthRef.current * 2;
                const dyHue = -(dyPx / effectivePpm) / depthRef.current * 2;

                const { x: newCx, y: newCy } = clampZoneCenter(
                  startCx + dxHue,
                  startCy + dyHue,
                  halfScaleX,
                  halfScaleY,
                );

                // Pixel delta from start, used to imperatively translate
                // the bounds box and bound channels.
                const deltaLeftPx = (hueToMetres(newCx, widthRef.current) - hueToMetres(startCx, widthRef.current)) * ppmRef.current;
                const deltaTopPx = (hueToMetres(-newCy, depthRef.current) - hueToMetres(-startCy, depthRef.current)) * ppmRef.current;

                // Center marker
                target.style.left = `${hueToMetres(newCx, widthRef.current) * ppmRef.current}px`;
                target.style.top = `${hueToMetres(-newCy, depthRef.current) * ppmRef.current}px`;
                target.dataset.cx = String(newCx);
                target.dataset.cy = String(newCy);

                if (boundsEl && boundsStart) {
                  boundsEl.style.left = `${boundsStart.left + deltaLeftPx}px`;
                  boundsEl.style.top = `${boundsStart.top + deltaTopPx}px`;
                  // The centre stops `scale` short of the wall, so on a large
                  // zone the marker parks far from the edge it is actually
                  // pinned against and the drag reads as broken. Name the edge.
                  boundsEl.dataset.zonePinned = pinnedZoneEdges(
                    { centerX: newCx, centerY: newCy },
                    { halfScaleX, halfScaleY },
                  );
                }
                // `zoneRelativePosition` is unchanged — only the world position
                // it projects to moves with the zone.
                for (const c of channelStarts) {
                  c.el.style.left = `${c.left + deltaLeftPx}px`;
                  c.el.style.top = `${c.top + deltaTopPx}px`;
                }
              };
              const stop = (pointerId: number) => {
                if (boundsEl) delete boundsEl.dataset.zonePinned;
                if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
                target.removeEventListener("pointermove", moveHandler);
                target.removeEventListener("pointerup", upHandler);
                target.removeEventListener("pointercancel", cancelHandler);
                window.removeEventListener("keydown", escHandler, true);
                zoneDragLive.current = null;
              };
              // Esc or a pointer the system took: the zone and its lights go back, nothing is written.
              const restore = () => {
                target.style.left = markerStart.left;
                target.style.top = markerStart.top;
                if (boundsEl && boundsStart) {
                  boundsEl.style.left = `${boundsStart.left}px`;
                  boundsEl.style.top = `${boundsStart.top}px`;
                }
                for (const c of channelStarts) {
                  c.el.style.left = `${c.left}px`;
                  c.el.style.top = `${c.top}px`;
                }
              };
              const cancelHandler = (cv: PointerEvent) => {
                stop(cv.pointerId);
                restore();
              };
              const escHandler = (kv: KeyboardEvent) => {
                if (kv.key !== "Escape") return;
                kv.preventDefault();
                kv.stopPropagation();
                stop(e.pointerId);
                restore();
              };
              const upHandler = (uv: PointerEvent) => {
                stop(uv.pointerId);
                if (!moved) return;
                const finalCx = parseFloat(target.dataset.cx ?? String(startCx));
                const finalCy = parseFloat(target.dataset.cy ?? String(startCy));
                if (finalCx !== startCx || finalCy !== startCy) {
                  onHueZoneCenterChange?.(zoneId, finalCx, finalCy);
                }
              };
              target.addEventListener("pointermove", moveHandler);
              target.addEventListener("pointerup", upHandler);
              target.addEventListener("pointercancel", cancelHandler);
              window.addEventListener("keydown", escHandler, true);
              zoneDragLive.current = () => {
                stop(e.pointerId);
                restore();
              };
            }}
          />
        </>
      )}

      {placed.map(({ ch, leftPx, topPx }) => {
        const fan = fans.get(ch.channelIndex);

        const isSelected = selectedId === hueChannelObjectId(ch.channelIndex);
        // When a Hue zone is active, channels NOT bound to it
        // are visually de-emphasised and pointer-disabled so the editor
        // becomes focused on the zone subset.
        const isInActiveHueZone = activeHueZone !== null && ch.zoneId === activeHueZone.id;
        const dimmedByHueZone = activeHueZone !== null && !isInActiveHueZone;

        const ring = isInActiveHueZone && activeHueZone?.borderColor ? `0 0 0 2px ${activeHueZone.borderColor}` : null;

        const isGhost =
          liveChannelIds != null && ch.channelId != null && !liveChannelIds.has(ch.channelId);
        const halo = glow && !isGhost && !dimmedByHueZone ? `0 0 ${4 + 10 * glow.level}px ${1 + 3 * glow.level}px ${glow.colour}` : null;
        const ringStyle: React.CSSProperties = ring || halo ? { boxShadow: [ring, halo].filter(Boolean).join(", ") } : {};
        const baseLabel = hueChannelName(ch, t);
        const facing = facings?.get(ch.channelIndex);
        const isOverhead = overhead?.has(ch.channelIndex) ?? false;
        const dotLabel = isGhost
          ? t("roomMap:hueChannel.ghostLabel", { name: baseLabel })
          : isOverhead
            ? t("roomMap:hueChannel.overheadLabel", { name: baseLabel })
            : baseLabel;

        return (
          <div
            key={ch.channelIndex}
            // Tag bound channels so the zone-center drag
            // handler can imperatively translate them by the same delta
            // as the dashed bounds box.
            data-zone-channel-id={isInActiveHueZone ? activeHueZone?.id : undefined}
            data-object-id={hueChannelObjectId(ch.channelIndex)}
            data-lit={halo ? "" : undefined}
            className="absolute"
            style={{
              left: leftPx + (fan?.dx ?? 0),
              top: topPx + (fan?.dy ?? 0),
              transform: "translate(-50%, -50%)",
              zIndex: 20,
              touchAction: "none",
            }}
          >
            {facing !== undefined && (
              <span
                aria-hidden="true"
                data-testid="hue-facing"
                className="lm-room-hue-beam pointer-events-none absolute left-1/2 top-1/2"
                style={{ transform: `rotate(${facing - 90}deg)` }}
              />
            )}
            {isOverhead && !isGhost && (
              <span
                aria-hidden="true"
                data-testid="hue-overhead"
                className={cx(
                  "lm-room-hue-overhead pointer-events-none absolute left-1/2 top-1/2",
                  isSelected && "lm-room-hue-overhead--selected",
                  dimmedByHueZone && "opacity-30",
                )}
                // The layer scales with the zoom; the dash should not.
                style={{ borderWidth: 1 / zoom }}
              />
            )}
            {fan && (
              // A thread back to the spot the bridge has it at.
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-1/2 top-1/2 bg-white/40"
                style={{
                  width: Math.hypot(fan.dx, fan.dy),
                  height: 1 / zoom,
                  transformOrigin: "0 50%",
                  transform: `rotate(${(Math.atan2(-fan.dy, -fan.dx) * 180) / Math.PI}deg)`,
                }}
              />
            )}
            <div
              role="button"
              // Dimmed dots take no pointer, so the keyboard must not reach them either.
              tabIndex={dimmedByHueZone ? -1 : 0}
              aria-disabled={dimmedByHueZone || undefined}
              aria-pressed={isSelected}
              aria-label={dotLabel}
              className={cx(
                // The disc is 12 px; the ring around it makes a 28 px target.
                "relative flex items-center justify-center rounded-full border-2 text-[8px] font-bold select-none before:absolute before:-inset-2 before:rounded-full before:content-['']",
                isSelected ? "w-4 h-4" : "w-3 h-3",
                isGhost
                  ? "lm-room-hue-dot--ghost border-dashed"
                  : isSelected
                    ? "bg-white border-white text-zinc-900"
                    : "bg-white/80 border-zinc-400 text-zinc-900",
                "cursor-grab active:cursor-grabbing",
                dimmedByHueZone ? "opacity-30 cursor-not-allowed pointer-events-none" : "",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60",
              )}
              style={{ touchAction: "none", ...ringStyle }}
              onPointerDown={(e) => {
                if (dimmedByHueZone) return;
                handlePointerDown(e, ch, fan);
              }}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={cancelDrag}
              onLostPointerCapture={cancelDrag}
              onClick={(e) => {
                e.stopPropagation();
                // A pointer's press already picked it; picking again would undo a ⇧-pick.
                if (e.detail === 0) onSelect(ch.channelIndex);
              }}
              onKeyDown={(e) => {
                if (dimmedByHueZone) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(ch.channelIndex);
                }
              }}
            >
              {hueChannelDotText(ch.channelId)}
            </div>
            <span
              aria-hidden="true"
              data-testid="hue-name"
              data-shown={isSelected || undefined}
              className="lm-room-hue-name"
              style={{ "--lm-hue-name-scale": 1 / zoom } as React.CSSProperties}
            >
              {baseLabel}
            </span>
          </div>
        );
      })}
    </>
  );
});
