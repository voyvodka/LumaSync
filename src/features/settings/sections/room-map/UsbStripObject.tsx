import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UsbStripPlacement } from "../../../../shared/contracts/roomMap";

interface UsbStripObjectProps {
  placement: UsbStripPlacement;
  pxPerMeter: number;
  selected: boolean;
  zoom?: number;
  panMode?: boolean;
  onSelect: (id: string) => void;
  onChange: (updated: UsbStripPlacement) => void;
}

type HandleType = "start" | "end" | "line";

/** Snap threshold in metres — if difference is within this, snap to axis */
const AXIS_SNAP_M = 0.15;

export function UsbStripObject({
  placement,
  pxPerMeter,
  selected,
  zoom = 1,
  panMode = false,
  onSelect,
  onChange,
}: UsbStripObjectProps) {
  const { t } = useTranslation("common");

  const [localSX, setLocalSX] = useState(placement.startX);
  const [localSY, setLocalSY] = useState(placement.startY);
  const [localEX, setLocalEX] = useState(placement.endX);
  const [localEY, setLocalEY] = useState(placement.endY);
  const [localLedCount, setLocalLedCount] = useState(placement.ledCount);
  const [axisSnap, setAxisSnap] = useState<"h" | "v" | null>(null);

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
    startPosX: number;
    startPosY: number;
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

  /** Apply axis snap when dragging an endpoint — snaps Y to match other end (horizontal) or X (vertical) */
  const applyAxisSnap = (
    movingSX: number, movingSY: number, moveEX: number, moveEY: number,
    handle: HandleType,
  ): { sx: number; sy: number; ex: number; ey: number; snap: "h" | "v" | null } => {
    if (handle === "line") return { sx: movingSX, sy: movingSY, ex: moveEX, ey: moveEY, snap: null };

    const anchorX = handle === "start" ? moveEX : movingSX;
    const anchorY = handle === "start" ? moveEY : movingSY;
    const dragX = handle === "start" ? movingSX : moveEX;
    const dragY = handle === "start" ? movingSY : moveEY;

    const diffX = Math.abs(dragX - anchorX);
    const diffY = Math.abs(dragY - anchorY);

    let snappedX = dragX;
    let snappedY = dragY;
    let snap: "h" | "v" | null = null;

    if (diffY < AXIS_SNAP_M) {
      snappedY = anchorY;
      snap = "h";
    } else if (diffX < AXIS_SNAP_M) {
      snappedX = anchorX;
      snap = "v";
    }

    if (handle === "start") {
      return { sx: snappedX, sy: snappedY, ex: moveEX, ey: moveEY, snap };
    }
    return { sx: movingSX, sy: movingSY, ex: snappedX, ey: snappedY, snap };
  };

  const handlePointerDown = (
    e: React.PointerEvent<HTMLDivElement | SVGLineElement>,
    handle: HandleType,
  ) => {
    if (panMode) return;
    e.stopPropagation();
    onSelect(placement.stripId);
    if (placement.locked) return;
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
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement | SVGLineElement>) => {
    if (!dragRef.current.active || !dragRef.current.handle) return;
    const effectivePpm = pxPerMeter * zoom;
    const dx = (e.clientX - dragRef.current.startClientX) / effectivePpm;
    const dy = (e.clientY - dragRef.current.startClientY) / effectivePpm;
    const handle = dragRef.current.handle;

    if (handle === "line") {
      setLocalSX(dragRef.current.startSX + dx);
      setLocalSY(dragRef.current.startSY + dy);
      setLocalEX(dragRef.current.startEX + dx);
      setLocalEY(dragRef.current.startEY + dy);
      setAxisSnap(null);
    } else {
      let rawSX = localSX, rawSY = localSY, rawEX = localEX, rawEY = localEY;
      if (handle === "start") {
        rawSX = dragRef.current.startPosX + dx;
        rawSY = dragRef.current.startPosY + dy;
      } else {
        rawEX = dragRef.current.startPosX + dx;
        rawEY = dragRef.current.startPosY + dy;
      }
      const snapped = applyAxisSnap(rawSX, rawSY, rawEX, rawEY, handle);
      setLocalSX(snapped.sx);
      setLocalSY(snapped.sy);
      setLocalEX(snapped.ex);
      setLocalEY(snapped.ey);
      setAxisSnap(snapped.snap);
    }
  };

  const handlePointerUp = () => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    setAxisSnap(null);
    if (
      localSX !== placement.startX ||
      localSY !== placement.startY ||
      localEX !== placement.endX ||
      localEY !== placement.endY
    ) {
      onChange({
        ...placement,
        startX: localSX,
        startY: localSY,
        endX: localEX,
        endY: localEY,
      });
    }
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
        style={{ zIndex: 1, pointerEvents: "none", overflow: "visible" }}
      >
        {/* Invisible wide stroke for easier line grab (pointer-events: stroke) */}
        <line
          x1={sx}
          y1={sy}
          x2={ex}
          y2={ey}
          stroke="transparent"
          strokeWidth="14"
          style={{ cursor: selected ? "grab" : "pointer", pointerEvents: "visibleStroke" }}
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
          stroke={selected ? (placement.locked ? "rgba(255,255,255,0.4)" : "#ffffff") : "#06b6d4"}
          strokeWidth={selected ? 2.5 : 2}
          strokeDasharray="4 4"
          style={{ pointerEvents: "none" }}
        />
        <polygon
          points="0,-6 5,0 -5,0"
          fill="#06b6d4"
          transform={`translate(${ex}, ${ey}) rotate(${angle + 90})`}
          style={{ pointerEvents: "none" }}
        />
        {/* Axis snap guide line — shown while dragging endpoint near horizontal/vertical */}
        {axisSnap === "h" && (
          <>
            <line
              x1={0} y1={sy} x2="100%" y2={sy}
              stroke="#22d3ee" strokeWidth="1" strokeDasharray="3 3" opacity={0.6}
              style={{ pointerEvents: "none" }}
            />
            <text
              x={Math.max(sx, ex) + 8} y={sy - 6}
              fill="#22d3ee" fontSize="9" fontWeight="bold" opacity={0.9}
              style={{ pointerEvents: "none" }}
            >
              H
            </text>
          </>
        )}
        {axisSnap === "v" && (
          <>
            <line
              x1={sx} y1={0} x2={sx} y2="100%"
              stroke="#22d3ee" strokeWidth="1" strokeDasharray="3 3" opacity={0.6}
              style={{ pointerEvents: "none" }}
            />
            <text
              x={sx + 6} y={Math.min(sy, ey) - 6}
              fill="#22d3ee" fontSize="9" fontWeight="bold" opacity={0.9}
              style={{ pointerEvents: "none" }}
            >
              V
            </text>
          </>
        )}
      </svg>

      {/* Start handle */}
      <div
        className={`absolute rounded-full cursor-grab active:cursor-grabbing ${
          selected
            ? "bg-white ring-2 ring-white/50"
            : "bg-cyan-500 ring-2 ring-white dark:ring-zinc-950"
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
        className={`absolute rounded-full cursor-grab active:cursor-grabbing ${
          selected
            ? "bg-white ring-2 ring-white/50"
            : "bg-cyan-500 ring-2 ring-white dark:ring-zinc-950"
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
