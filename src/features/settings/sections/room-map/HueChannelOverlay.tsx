import { useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { HueChannelPlacement } from "../../../../shared/contracts/roomMap";

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

interface DragState {
  active: boolean;
  channelIndex: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
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
        element: el,
      };
    },
    [onSelect],
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

    const newX = clamp(dr.startX + dxHue, -1, 1);
    const newY = clamp(dr.startY + dyHue, -1, 1);

    dr.currentX = newX;
    dr.currentY = newY;

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
      onChangeRef.current({ ...ch, x: dr.currentX, y: dr.currentY });
    }

    dragRef.current = { ...EMPTY_DRAG };
  }, []);

  return (
    <>
      {channels.map((ch) => {
        const leftPx = hueToMetres(ch.x, roomWidthM) * pxPerMeter;
        // Invert Y: Hue +y = front wall (bottom of canvas)
        const topPx = hueToMetres(-ch.y, roomDepthM) * pxPerMeter;

        const isSelected = selectedId === `hue-${ch.channelIndex}`;
        const isInActiveZone = activeZoneChannels?.has(ch.channelIndex) ?? false;
        const isAssignedToAnyZone = assignedChannels?.has(ch.channelIndex) ?? false;

        const isUnassignedInZoneMode = zoneAssignMode && !isAssignedToAnyZone;

        const ringStyle: React.CSSProperties =
          zoneAssignMode && isInActiveZone && activeZoneColor
            ? { boxShadow: `0 0 0 2px ${activeZoneColor}` }
            : {};

        const dotLabel =
          ch.label ??
          t("roomMap.hueChannel.defaultLabel", { index: String(ch.channelIndex + 1) });

        return (
          <div
            key={ch.channelIndex}
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
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ touchAction: "none", ...ringStyle }}
              onPointerDown={(e) => {
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
