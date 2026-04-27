import { useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { HueChannelPlacement, HueZone } from "../../../../shared/contracts/roomMap";

interface HueChannelOverlayProps {
  channels: HueChannelPlacement[];
  pxPerMeter: number;
  roomWidthM: number;
  roomDepthM: number;
  zoom?: number;
  selectedId: string | null;
  onSelect: (channelIndex: number) => void;
  onChange: (updated: HueChannelPlacement) => void;
  /** When true, clicks toggle zone membership instead of selecting */
  zoneAssignMode?: boolean;
  /** CSS/hex color for the active zone ring */
  activeZoneColor?: string | null;
  /** Channel indices assigned to ANY zone */
  assignedChannels?: Set<number>;
  /** Channel indices assigned to the ACTIVE zone */
  activeZoneChannels?: Set<number>;
  /** Called with channel index when toggling zone membership */
  onChannelZoneToggle?: (channelIndex: number) => void;
  /** When true, space is held — don't start drag */
  panMode?: boolean;
  /**
   * v1.5 W1-A6 — when set, the overlay enters "Hue zone scope" mode:
   * - Channels bound to this zone render at zone-relative coordinates
   *   resolved against the zone's center+scale.
   * - Channels NOT in the zone render greyed out and pointer-disabled.
   * - The zone center marker + bounds box are drawn behind the channels.
   * - Drag updates emit `zoneRelativePosition` (and the absolute fields
   *   are kept consistent so legacy consumers still work).
   */
  activeHueZone?: HueZone | null;
  /** Called when the user drags the zone center marker. */
  onHueZoneCenterChange?: (zoneId: string, centerX: number, centerY: number) => void;
}

/**
 * Convert Hue coordinate [-1, 1] to room metres [0, roomSize].
 * Hue x: -1=left edge, +1=right edge
 * Hue y: +1=front wall (bottom of canvas), -1=back wall (top of canvas)
 */
function hueToMetres(hueVal: number, roomSizeM: number): number {
  return ((hueVal + 1) / 2) * roomSizeM;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Project a world-space Hue coordinate into the active zone's bounds.
 *
 * Bug #52(a) — channel drag must never escape the parent zone box.
 * Pipeline:
 *   1. Clamp world to `[-1, 1]` (Hue cube, the bridge cap).
 *   2. Invert through the zone transform → relative space.
 *   3. Clamp relative to `[-1, 1]` (zone box).
 *   4. Re-project to world via `center + scale * relative`.
 *
 * Returns both the bounded world tuple and the matching zone-relative
 * coordinates so the drag handler can persist them in one shot. When
 * `scale*` is 0 the zone is degenerate; we fall back to the world-clamped
 * value with `rel = 0` to avoid a divide-by-zero.
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
};

/**
 * Renders Hue channel dots on the room map canvas.
 *
 * Positions are computed in pixels (pxPerMeter * room metres) so they stay
 * aligned with all other room objects regardless of panel open/close resizing.
 */
export function HueChannelOverlay({
  channels,
  pxPerMeter,
  roomWidthM,
  roomDepthM,
  zoom = 1,
  selectedId,
  onSelect,
  onChange,
  zoneAssignMode = false,
  activeZoneColor = null,
  assignedChannels,
  activeZoneChannels,
  onChannelZoneToggle,
  panMode = false,
  activeHueZone = null,
  onHueZoneCenterChange,
}: HueChannelOverlayProps) {
  const { t } = useTranslation("common");

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

  const onChannelZoneToggleRef = useRef(onChannelZoneToggle);
  onChannelZoneToggleRef.current = onChannelZoneToggle;

  const activeHueZoneRef = useRef(activeHueZone);
  activeHueZoneRef.current = activeHueZone;

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, ch: HueChannelPlacement) => {
      if (panMode) return;
      e.stopPropagation();
      onSelect(ch.channelIndex);
      if (ch.locked) return;
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);

      dragRef.current = {
        active: true,
        channelIndex: ch.channelIndex,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startX: ch.x,
        startY: ch.y,
        currentX: ch.x,
        currentY: ch.y,
        currentRelX: ch.zoneRelativePosition?.x ?? null,
        currentRelY: ch.zoneRelativePosition?.y ?? null,
        element: el,
      };
    },
    [onSelect, panMode],
  );

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const dr = dragRef.current;
    if (!dr.active) return;

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

    // Bug #52(a) — when this channel is bound to the active zone, clamp
    // the world coords through the zone box so the dot can never visually
    // leave the zone bounds.
    const zone = activeHueZoneRef.current;
    const ch = channelsRef.current.find((c) => c.channelIndex === dr.channelIndex);
    if (zone && ch && ch.zoneId === zone.id) {
      const bounded = clampWithinZone(newX, newY, zone);
      newX = bounded.worldX;
      newY = bounded.worldY;
      relX = bounded.relX;
      relY = bounded.relY;
    }

    dr.currentX = newX;
    dr.currentY = newY;
    dr.currentRelX = relX;
    dr.currentRelY = relY;

    // Imperative DOM update for smooth drag — avoids re-render
    const wrapper = dr.element?.parentElement;
    if (wrapper) {
      const leftPx = hueToMetres(newX, widthRef.current) * ppmRef.current;
      const topPx = hueToMetres(-newY, depthRef.current) * ppmRef.current;
      wrapper.style.left = `${leftPx}px`;
      wrapper.style.top = `${topPx}px`;
    }
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const dr = dragRef.current;
    if (!dr.active) return;

    e.currentTarget.releasePointerCapture(e.pointerId);

    const ch = channelsRef.current.find((c) => c.channelIndex === dr.channelIndex);
    if (ch && (dr.currentX !== ch.x || dr.currentY !== ch.y)) {
      const zone = activeHueZoneRef.current;
      // When the channel is bound to the active Hue zone, the absolute
      // x/y we computed during the drag are world-space; we persist the
      // already-clamped zone-relative pair captured in the move handler
      // so HUE_ZONE_CHANNEL_OUT_OF_BOUNDS never round-trips to the
      // bridge.
      if (zone && ch.zoneId === zone.id && dr.currentRelX !== null && dr.currentRelY !== null) {
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

  // ── v1.5 W1-A6: zone bounds + center marker (rendered behind channels) ──
  const zoneBoundsBox = activeHueZone
    ? (() => {
        const zone = activeHueZone;
        const minX = clamp(zone.centerX - Math.abs(zone.scaleX), -1, 1);
        const maxX = clamp(zone.centerX + Math.abs(zone.scaleX), -1, 1);
        const minY = clamp(zone.centerY - Math.abs(zone.scaleY), -1, 1);
        const maxY = clamp(zone.centerY + Math.abs(zone.scaleY), -1, 1);
        const leftPx = hueToMetres(minX, roomWidthM) * pxPerMeter;
        const rightPx = hueToMetres(maxX, roomWidthM) * pxPerMeter;
        // Y flip: Hue +y is front wall (canvas bottom)
        const topPx = hueToMetres(-maxY, roomDepthM) * pxPerMeter;
        const bottomPx = hueToMetres(-minY, roomDepthM) * pxPerMeter;
        const centerLeftPx = hueToMetres(zone.centerX, roomWidthM) * pxPerMeter;
        const centerTopPx = hueToMetres(-zone.centerY, roomDepthM) * pxPerMeter;
        const color = zone.borderColor ?? "var(--lm-zone-1)";
        return { leftPx, rightPx, topPx, bottomPx, centerLeftPx, centerTopPx, color };
      })()
    : null;

  return (
    <>
      {/* Zone bounds box + center marker — only when a Hue zone is active */}
      {activeHueZone && zoneBoundsBox && (
        <>
          {/* Zone label chip — pinned at bounds top-left so the user can
              read the active zone name at a glance even when the dashed
              border is faint or partially off-screen. */}
          <div
            className="lm-room-zone-chip"
            style={{
              left: Math.max(8, zoneBoundsBox.leftPx + 6),
              top: Math.max(8, zoneBoundsBox.topPx - 22),
            }}
            aria-hidden
          >
            <span
              className="lm-room-zone-chip-dot"
              style={{ background: zoneBoundsBox.color }}
            />
            <span>{activeHueZone.name}</span>
            <span className="lm-room-zone-chip-tip">
              {t("roomMap.hueZones.activeChipTip")}
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
              // Wave 4-B (B4) — softer border + lighter fill so the
              // dashed outline reads as a hint, not a frame. The pinned
              // zone label chip carries the identity signal; the canvas
              // tint just nudges the eye towards the bounds.
              border: `1px dashed color-mix(in srgb, ${zoneBoundsBox.color} 60%, transparent)`,
              background: `color-mix(in srgb, ${zoneBoundsBox.color} 2%, transparent)`,
              zIndex: 18,
            }}
            aria-hidden
          />
          <div
            role="button"
            tabIndex={0}
            aria-label={t("roomMap.hueZones.centerMarkerAriaLabel", { name: activeHueZone.name })}
            title={t("roomMap.hueZones.centerMarkerAriaLabel", { name: activeHueZone.name })}
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

              // Bug #50/#52(b) — collect every DOM node that must follow
              // the center: the dashed bounds box AND each channel dot
              // bound to this zone. Cache their start positions so we can
              // apply the delta imperatively during pointermove without
              // a React re-render per move event.
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

              const moveHandler = (mv: PointerEvent) => {
                const dxPx = mv.clientX - startClientX;
                const dyPx = mv.clientY - startClientY;
                const dxHue = (dxPx / effectivePpm) / widthRef.current * 2;
                const dyHue = -(dyPx / effectivePpm) / depthRef.current * 2;

                // Bug #53 / #50 — keep the entire zone box (center ±
                // half-scale) inside the Hue cube while dragging. Without
                // this, the bounds box visually overflows the room map.
                const minCx = -1 + halfScaleX;
                const maxCx = 1 - halfScaleX;
                const minCy = -1 + halfScaleY;
                const maxCy = 1 - halfScaleY;
                // halfScaleX/Y can exceed 1 for degenerate zones; fall back
                // to plain world clamp so the marker still follows the cursor.
                const newCx = halfScaleX > 1 ? clamp(startCx + dxHue, -1, 1) : clamp(startCx + dxHue, minCx, maxCx);
                const newCy = halfScaleY > 1 ? clamp(startCy + dyHue, -1, 1) : clamp(startCy + dyHue, minCy, maxCy);

                // Pixel delta from start, used to imperatively translate
                // the bounds box and bound channels.
                const deltaLeftPx = (hueToMetres(newCx, widthRef.current) - hueToMetres(startCx, widthRef.current)) * ppmRef.current;
                const deltaTopPx = (hueToMetres(-newCy, depthRef.current) - hueToMetres(-startCy, depthRef.current)) * ppmRef.current;

                // Center marker
                target.style.left = `${hueToMetres(newCx, widthRef.current) * ppmRef.current}px`;
                target.style.top = `${hueToMetres(-newCy, depthRef.current) * ppmRef.current}px`;
                target.dataset.cx = String(newCx);
                target.dataset.cy = String(newCy);

                // Bug #50 — dashed bounds box follows the center delta.
                if (boundsEl && boundsStart) {
                  boundsEl.style.left = `${boundsStart.left + deltaLeftPx}px`;
                  boundsEl.style.top = `${boundsStart.top + deltaTopPx}px`;
                }
                // Bug #52(b) — every bound channel dot follows by the
                // same delta. Their persisted zoneRelativePosition is
                // unchanged; only the world position they project to
                // moves with the zone.
                for (const c of channelStarts) {
                  c.el.style.left = `${c.left + deltaLeftPx}px`;
                  c.el.style.top = `${c.top + deltaTopPx}px`;
                }
              };
              const upHandler = (uv: PointerEvent) => {
                target.releasePointerCapture(uv.pointerId);
                target.removeEventListener("pointermove", moveHandler);
                target.removeEventListener("pointerup", upHandler);
                target.removeEventListener("pointercancel", upHandler);
                const finalCx = parseFloat(target.dataset.cx ?? String(startCx));
                const finalCy = parseFloat(target.dataset.cy ?? String(startCy));
                if (finalCx !== startCx || finalCy !== startCy) {
                  onHueZoneCenterChange?.(zoneId, finalCx, finalCy);
                }
              };
              target.addEventListener("pointermove", moveHandler);
              target.addEventListener("pointerup", upHandler);
              target.addEventListener("pointercancel", upHandler);
            }}
          />
        </>
      )}

      {channels.map((ch) => {
        // ── v1.5 W1-A6: when in Hue zone scope, derive world position
        // from the zone-relative coordinates so dragging the zone center
        // moves all bound channels together without a per-channel update.
        let worldX = ch.x;
        let worldY = ch.y;
        if (activeHueZone && ch.zoneId === activeHueZone.id && ch.zoneRelativePosition) {
          worldX = clamp(
            activeHueZone.centerX + activeHueZone.scaleX * ch.zoneRelativePosition.x,
            -1,
            1,
          );
          worldY = clamp(
            activeHueZone.centerY + activeHueZone.scaleY * ch.zoneRelativePosition.y,
            -1,
            1,
          );
        }
        const leftPx = hueToMetres(worldX, roomWidthM) * pxPerMeter;
        // Invert Y: Hue +y = front wall (bottom of canvas)
        const topPx = hueToMetres(-worldY, roomDepthM) * pxPerMeter;

        const isSelected = selectedId === `hue-${ch.channelIndex}`;
        const isInActiveZone = activeZoneChannels?.has(ch.channelIndex) ?? false;
        const isAssignedToAnyZone = assignedChannels?.has(ch.channelIndex) ?? false;

        const isUnassignedInZoneMode = zoneAssignMode && !isAssignedToAnyZone;

        // v1.5 W1-A6 — when a Hue zone is active, channels NOT bound to it
        // are visually de-emphasised and pointer-disabled so the editor
        // becomes focused on the zone subset.
        const isInActiveHueZone = activeHueZone !== null && ch.zoneId === activeHueZone.id;
        const dimmedByHueZone = activeHueZone !== null && !isInActiveHueZone;

        const ringStyle: React.CSSProperties =
          zoneAssignMode && isInActiveZone && activeZoneColor
            ? { boxShadow: `0 0 0 2px ${activeZoneColor}` }
            : isInActiveHueZone && activeHueZone?.borderColor
              ? { boxShadow: `0 0 0 2px ${activeHueZone.borderColor}` }
              : {};

        const dotLabel =
          ch.label ??
          t("roomMap.hueChannel.defaultLabel", { index: String(ch.channelIndex + 1) });

        return (
          <div
            key={ch.channelIndex}
            // Bug #50 — tag bound channels so the zone-center drag
            // handler can imperatively translate them by the same delta
            // as the dashed bounds box.
            data-zone-channel-id={isInActiveHueZone ? activeHueZone?.id : undefined}
            className="absolute"
            style={{
              left: leftPx,
              top: topPx,
              transform: "translate(-50%, -50%)",
              zIndex: 20,
              touchAction: "none",
            }}
          >
            <div
              role="button"
              tabIndex={0}
              aria-pressed={zoneAssignMode ? isInActiveZone : isSelected}
              aria-label={dotLabel}
              title={dotLabel}
              className={[
                "flex items-center justify-center rounded-full border-2 text-[8px] font-bold select-none",
                isSelected ? "w-4 h-4" : "w-3 h-3",
                isSelected ? "bg-white border-white text-zinc-900" : "bg-white/80 border-zinc-400 text-zinc-900",
                zoneAssignMode ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
                isUnassignedInZoneMode ? "opacity-50" : "",
                dimmedByHueZone ? "opacity-30 cursor-not-allowed pointer-events-none" : "",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ touchAction: "none", ...ringStyle }}
              onPointerDown={(e) => {
                if (dimmedByHueZone) return;
                handlePointerDown(e, ch);
              }}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onClick={(e) => {
                e.stopPropagation();
                if (zoneAssignMode) {
                  onChannelZoneToggleRef.current?.(ch.channelIndex);
                } else {
                  onSelect(ch.channelIndex);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (zoneAssignMode) {
                    onChannelZoneToggleRef.current?.(ch.channelIndex);
                  } else {
                    onSelect(ch.channelIndex);
                  }
                }
              }}
            >
              {ch.channelIndex + 1}
            </div>
          </div>
        );
      })}
    </>
  );
}
