import { useRef, useState, useCallback } from "react";
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
 * Hue x: -1=left  → 0%,  +1=right → 100%
 * Hue y: -1=back  → 0% (top),  +1=front → 100% (bottom) — NOTE: Y is inverted for CSS `top`
 */
function posToPercent(val: number): number {
  return ((val + 1) / 2) * 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface DragRef {
  active: boolean;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  channelIndex: number;
}

export function HueChannelOverlay({
  channels,
  canvasSize,
  selectedId,
  onSelect,
  onChange,
}: HueChannelOverlayProps) {
  const { t } = useTranslation("common");

  const dragRef = useRef<DragRef>({
    active: false,
    startClientX: 0,
    startClientY: 0,
    startX: 0,
    startY: 0,
    channelIndex: -1,
  });

  // Local position state during drag (keyed by channelIndex)
  const [localPositions, setLocalPositions] = useState<Map<number, { x: number; y: number }>>(
    new Map(),
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, ch: HueChannelPlacement) => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        active: true,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startX: ch.x,
        startY: ch.y,
        channelIndex: ch.channelIndex,
      };
      setLocalPositions((prev) => {
        const next = new Map(prev);
        next.set(ch.channelIndex, { x: ch.x, y: ch.y });
        return next;
      });
      onSelect(ch.channelIndex);
    },
    [onSelect],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const dr = dragRef.current;
      if (!dr.active || canvasSize.w === 0 || canvasSize.h === 0) return;

      const dxPx = e.clientX - dr.startClientX;
      const dyPx = e.clientY - dr.startClientY;

      // Convert pixel delta to Hue coordinate delta
      // Canvas width represents 2 units of Hue space [-1, 1]
      const dxHue = (dxPx / canvasSize.w) * 2;
      // Y is inverted: dragging down increases CSS top but decreases Hue y
      const dyHue = -(dyPx / canvasSize.h) * 2;

      const newX = clamp(dr.startX + dxHue, -1, 1);
      const newY = clamp(dr.startY + dyHue, -1, 1);

      setLocalPositions((prev) => {
        const next = new Map(prev);
        next.set(dr.channelIndex, { x: newX, y: newY });
        return next;
      });
    },
    [canvasSize],
  );

  const handlePointerUp = useCallback(
    (_e: React.PointerEvent<HTMLDivElement>, ch: HueChannelPlacement) => {
      const dr = dragRef.current;
      if (!dr.active) return;

      const pos = localPositions.get(ch.channelIndex);
      if (pos) {
        onChange({ ...ch, x: pos.x, y: pos.y });
      }

      dragRef.current = {
        active: false,
        startClientX: 0,
        startClientY: 0,
        startX: 0,
        startY: 0,
        channelIndex: -1,
      };
    },
    [localPositions, onChange],
  );

  return (
    <>
      {channels.map((ch) => {
        const localPos = localPositions.get(ch.channelIndex);
        const displayX = localPos?.x ?? ch.x;
        const displayY = localPos?.y ?? ch.y;

        const leftPct = posToPercent(displayX);
        // Invert Y: Hue +y = front wall = bottom of canvas (CSS top = higher value)
        // Hue y=-1 → top: 0% (back wall top), Hue y=+1 → top: 100% (front wall bottom)
        const topPct = posToPercent(-displayY);

        const isSelected = selectedId === `hue-${ch.channelIndex}`;
        const isDragging = dragRef.current.active && dragRef.current.channelIndex === ch.channelIndex;

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
            }}
          >
            <div
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              aria-label={dotLabel}
              title={dotLabel}
              className={[
                "flex items-center justify-center rounded-full border-2 text-[8px] font-bold text-zinc-900 select-none",
                // Size: larger when selected
                isSelected ? "w-4 h-4" : "w-3 h-3",
                // Background: white dot
                "bg-white",
                // Border: zinc-400 for unassigned (room map has no region assignments)
                "border-zinc-400",
                // Ring when selected
                isSelected ? "ring-2 ring-white/70" : "",
                // Cursor
                isDragging ? "cursor-grabbing" : "cursor-grab",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60",
              ]
                .filter(Boolean)
                .join(" ")}
              onPointerDown={(e) => {
                handlePointerDown(e, ch);
              }}
              onPointerMove={handlePointerMove}
              onPointerUp={(e) => {
                handlePointerUp(e, ch);
              }}
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
