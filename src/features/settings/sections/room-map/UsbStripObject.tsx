import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UsbStripPlacement } from "../../../../shared/contracts/roomMap";

interface UsbStripObjectProps {
  placement: UsbStripPlacement;
  pxPerMeter: number;
  selected: boolean;
  onSelect: (id: string) => void;
  onChange: (updated: UsbStripPlacement) => void;
}

type HandleType = "start" | "end" | "line";

export function UsbStripObject({
  placement,
  pxPerMeter,
  selected,
  onSelect,
  onChange,
}: UsbStripObjectProps) {
  const { t } = useTranslation("common");

  const [localSX, setLocalSX] = useState(placement.startX);
  const [localSY, setLocalSY] = useState(placement.startY);
  const [localEX, setLocalEX] = useState(placement.endX);
  const [localEY, setLocalEY] = useState(placement.endY);
  const [localLedCount, setLocalLedCount] = useState(placement.ledCount);

  // Sync local state when prop changes
  const prevPlacement = useRef(placement);
  if (prevPlacement.current !== placement) {
    prevPlacement.current = placement;
    setLocalSX(placement.startX);
    setLocalSY(placement.startY);
    setLocalEX(placement.endX);
    setLocalEY(placement.endY);
    setLocalLedCount(placement.ledCount);
  }

  const dragRef = useRef<{
    active: boolean;
    handle: HandleType | null;
    startClientX: number;
    startClientY: number;
    // For start/end handle: single position
    startPosX: number;
    startPosY: number;
    // For line drag: both endpoints
    startSX: number;
    startSY: number;
    startEX: number;
    startEY: number;
  }>({
    active: false,
    handle: null,
    startClientX: 0,
    startClientY: 0,
    startPosX: 0,
    startPosY: 0,
    startSX: 0,
    startSY: 0,
    startEX: 0,
    startEY: 0,
  });

  const handlePointerDown = (
    e: React.PointerEvent<HTMLDivElement | SVGLineElement>,
    handle: HandleType,
  ) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      active: true,
      handle,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPosX: handle === "start" ? localSX : localEX,
      startPosY: handle === "start" ? localSY : localEY,
      startSX: localSX,
      startSY: localSY,
      startEX: localEX,
      startEY: localEY,
    };
    onSelect(placement.stripId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement | SVGLineElement>) => {
    if (!dragRef.current.active || !dragRef.current.handle) return;
    const dx = (e.clientX - dragRef.current.startClientX) / pxPerMeter;
    const dy = (e.clientY - dragRef.current.startClientY) / pxPerMeter;

    if (dragRef.current.handle === "line") {
      // Move both endpoints together
      setLocalSX(dragRef.current.startSX + dx);
      setLocalSY(dragRef.current.startSY + dy);
      setLocalEX(dragRef.current.startEX + dx);
      setLocalEY(dragRef.current.startEY + dy);
    } else if (dragRef.current.handle === "start") {
      setLocalSX(dragRef.current.startPosX + dx);
      setLocalSY(dragRef.current.startPosY + dy);
    } else {
      setLocalEX(dragRef.current.startPosX + dx);
      setLocalEY(dragRef.current.startPosY + dy);
    }
  };

  const handlePointerUp = () => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    onChange({
      ...placement,
      startX: localSX,
      startY: localSY,
      endX: localEX,
      endY: localEY,
    });
  };

  const handleLedCountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    const clamped = isNaN(val) ? 1 : Math.max(1, Math.min(1000, val));
    setLocalLedCount(clamped);
    onChange({ ...placement, ledCount: clamped });
  };

  // Pixel positions
  const sx = localSX * pxPerMeter;
  const sy = localSY * pxPerMeter;
  const ex = localEX * pxPerMeter;
  const ey = localEY * pxPerMeter;

  // Arrow angle at end point
  const angle = Math.atan2(ey - sy, ex - sx) * (180 / Math.PI);

  // Midpoint for LED count input
  const midX = (sx + ex) / 2;
  const midY = (sy + ey) / 2;

  return (
    <>
      {/* SVG line + arrow + invisible wide hit area for line drag */}
      <svg
        className="absolute inset-0 w-full h-full"
        style={{ zIndex: 1 }}
      >
        {/* Invisible wide stroke for easier line grab (pointer-events: stroke) */}
        <line
          x1={sx}
          y1={sy}
          x2={ex}
          y2={ey}
          stroke="transparent"
          strokeWidth="14"
          style={{ cursor: selected ? "grab" : "pointer", pointerEvents: "stroke" }}
          onPointerDown={(e) => handlePointerDown(e, "line")}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(placement.stripId);
          }}
        />
        {/* Visible dashed line */}
        <line
          x1={sx}
          y1={sy}
          x2={ex}
          y2={ey}
          stroke="#06b6d4"
          strokeWidth="2"
          strokeDasharray="4 4"
          style={{ pointerEvents: "none" }}
        />
        <polygon
          points="0,-6 5,0 -5,0"
          fill="#06b6d4"
          transform={`translate(${ex}, ${ey}) rotate(${angle + 90})`}
          style={{ pointerEvents: "none" }}
        />
      </svg>

      {/* Start handle */}
      <div
        className={`absolute rounded-full bg-cyan-500 cursor-grab active:cursor-grabbing ${
          selected
            ? "ring-4 ring-cyan-500/50"
            : "ring-2 ring-white dark:ring-zinc-950"
        }`}
        style={{
          width: 12,
          height: 12,
          left: sx - 6,
          top: sy - 6,
          zIndex: 20,
          touchAction: "none",
        }}
        onPointerDown={(e) => handlePointerDown(e, "start")}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />

      {/* End handle */}
      <div
        className={`absolute rounded-full bg-cyan-500 cursor-grab active:cursor-grabbing ${
          selected
            ? "ring-4 ring-cyan-500/50"
            : "ring-2 ring-white dark:ring-zinc-950"
        }`}
        style={{
          width: 12,
          height: 12,
          left: ex - 6,
          top: ey - 6,
          zIndex: 20,
          touchAction: "none",
        }}
        onPointerDown={(e) => handlePointerDown(e, "end")}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />

      {/* LED count input shown when selected */}
      {selected && (
        <div
          className="absolute z-30 flex items-center gap-1 rounded border border-cyan-500 bg-white px-1.5 py-0.5 shadow dark:bg-zinc-900"
          style={{
            left: midX - 48,
            top: midY - 20,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <label className="text-[10px] text-slate-600 dark:text-zinc-400 whitespace-nowrap">
            {t("roomMap.usbStrip.ledCount")}
          </label>
          <input
            type="number"
            min={1}
            max={1000}
            value={localLedCount}
            onChange={handleLedCountChange}
            className="w-14 rounded border border-slate-200 bg-transparent px-1 text-[10px] text-slate-900 dark:border-zinc-700 dark:text-zinc-100 focus:outline-none"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
