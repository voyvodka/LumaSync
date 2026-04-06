import { useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { HueChannelPlacement } from "../../../../shared/contracts/roomMap";

interface HueChannelOverlayProps {
  channels: HueChannelPlacement[];
  canvasSize: { w: number; h: number };
  selectedId: string | null;
  onSelect: (channelIndex: number) => void;
  onChange: (updated: HueChannelPlacement) => void;
}

/**
 * Convert Hue coordinate [-1, 1] to CSS percentage [0%, 100%].
 *
 * Hue x: -1=left  -> 0%,  +1=right -> 100%
 */
function posToPercent(val: number): number {
  return ((val + 1) / 2) * 100;
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
  /** Live drag position — updated on each pointer move so pointerUp can read final value */
  currentX: number;
  currentY: number;
  /** The element whose render needs updating */
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
 * Uses imperative DOM manipulation during drag to avoid React re-render overhead
 * and stale closure issues with pointer capture. Position is committed to React
 * state only on pointer up via onChange callback.
 */
export function HueChannelOverlay({
  channels,
  canvasSize,
  selectedId,
  onSelect,
  onChange,
}: HueChannelOverlayProps) {
  const { t } = useTranslation("common");

  const dragRef = useRef<DragState>({ ...EMPTY_DRAG });

  /** Lookup channel by index from current channels prop via ref to avoid stale closure */
  const channelsRef = useRef(channels);
  channelsRef.current = channels;

  const canvasSizeRef = useRef(canvasSize);
  canvasSizeRef.current = canvasSize;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, ch: HueChannelPlacement) => {
      e.stopPropagation();
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

      onSelect(ch.channelIndex);
    },
    [onSelect],
  );

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const dr = dragRef.current;
    const cs = canvasSizeRef.current;
    if (!dr.active || cs.w === 0 || cs.h === 0) return;

    const dxPx = e.clientX - dr.startClientX;
    const dyPx = e.clientY - dr.startClientY;

    // Convert pixel delta to Hue coordinate delta
    const dxHue = (dxPx / cs.w) * 2;
    // Y inverted: CSS down = Hue y decrease
    const dyHue = -(dyPx / cs.h) * 2;

    const newX = clamp(dr.startX + dxHue, -1, 1);
    const newY = clamp(dr.startY + dyHue, -1, 1);

    dr.currentX = newX;
    dr.currentY = newY;

    // Imperative DOM update for smooth drag — avoids re-render
    const wrapper = dr.element?.parentElement;
    if (wrapper) {
      wrapper.style.left = `${posToPercent(newX)}%`;
      wrapper.style.top = `${posToPercent(-newY)}%`;
    }
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const dr = dragRef.current;
    if (!dr.active) return;

    e.currentTarget.releasePointerCapture(e.pointerId);

    const ch = channelsRef.current.find((c) => c.channelIndex === dr.channelIndex);
    if (ch) {
      onChangeRef.current({ ...ch, x: dr.currentX, y: dr.currentY });
    }

    dragRef.current = { ...EMPTY_DRAG };
  }, []);

  return (
    <>
      {channels.map((ch) => {
        const leftPct = posToPercent(ch.x);
        // Invert Y: Hue +y = front wall (bottom of canvas)
        const topPct = posToPercent(-ch.y);

        const isSelected = selectedId === `hue-${ch.channelIndex}`;

        const dotLabel =
          ch.label ??
          t("roomMap.hueChannel.defaultLabel", { index: String(ch.channelIndex + 1) });

        return (
          <div
            key={ch.channelIndex}
            className="absolute"
            style={{
              left: `${leftPct}%`,
              top: `${topPct}%`,
              transform: "translate(-50%, -50%)",
              zIndex: 20,
              touchAction: "none",
            }}
          >
            <div
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              aria-label={dotLabel}
              title={dotLabel}
              className={[
                "flex items-center justify-center rounded-full border-2 text-[8px] font-bold select-none",
                isSelected ? "w-4 h-4" : "w-3 h-3",
                isSelected ? "bg-white border-white text-zinc-900" : "bg-white/80 border-zinc-400 text-zinc-900",
                "cursor-grab active:cursor-grabbing",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ touchAction: "none" }}
              onPointerDown={(e) => {
                handlePointerDown(e, ch);
              }}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(ch.channelIndex);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(ch.channelIndex);
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
