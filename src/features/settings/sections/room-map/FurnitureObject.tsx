import { useRef, useState } from "react";
import type { FurniturePlacement } from "../../../../shared/contracts/roomMap";
import { ResizeHandle } from "./ResizeHandle";
import type { SnapResult } from "./useSnapGuides";

const FURNITURE_COLORS: Record<
  FurniturePlacement["type"],
  { bg: string; border: string }
> = {
  sofa: {
    bg: "bg-slate-400/35 dark:bg-slate-600/35",
    border: "border-slate-400",
  },
  table: {
    bg: "bg-amber-400/35 dark:bg-amber-600/35",
    border: "border-amber-500",
  },
  chair: {
    bg: "bg-emerald-400/35 dark:bg-emerald-600/35",
    border: "border-emerald-500",
  },
  other: {
    bg: "bg-violet-400/35 dark:bg-violet-600/35",
    border: "border-violet-500",
  },
};

const MIN_SIZE_PX = 24;

interface FurnitureObjectProps {
  placement: FurniturePlacement;
  pxPerMeter: number;
  selected: boolean;
  gridStepPx: number;
  snapEnabled: boolean;
  zoom?: number;
  panMode?: boolean;
  onSelect: (id: string) => void;
  onChange: (updated: FurniturePlacement) => void;
  onSnapDragMove?: (id: string, x: number, y: number, w: number, h: number) => SnapResult;
  onSnapDragEnd?: () => void;
}

export function FurnitureObject({
  placement,
  pxPerMeter,
  selected,
  gridStepPx,
  snapEnabled,
  onSelect,
  onChange,
  onSnapDragMove,
  onSnapDragEnd,
  zoom = 1,
  panMode = false,
}: FurnitureObjectProps) {
  const [localX, setLocalX] = useState(placement.x);
  const [localY, setLocalY] = useState(placement.y);
  const [localW, setLocalW] = useState(placement.width);
  const [localH, setLocalH] = useState(placement.height);

  // Sync local state when placement prop changes from outside
  const prevPlacement = useRef(placement);
  if (prevPlacement.current !== placement) {
    prevPlacement.current = placement;
    setLocalX(placement.x);
    setLocalY(placement.y);
    setLocalW(placement.width);
    setLocalH(placement.height);
  }

  const dragRef = useRef<{
    active: boolean;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
  }>({ active: false, startClientX: 0, startClientY: 0, startX: 0, startY: 0 });

  const resizeRef = useRef<{
    active: boolean;
    corner: "nw" | "ne" | "sw" | "se" | null;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  }>({ active: false, corner: null, startX: 0, startY: 0, startW: 0, startH: 0 });

  const minSizeM = MIN_SIZE_PX / pxPerMeter;

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (resizeRef.current.active) return;
    if (panMode) return; // Let event bubble up for canvas pan
    onSelect(placement.id);
    if (placement.locked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      active: true,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: localX,
      startY: localY,
    };
  };

  const snapResultRef = useRef<SnapResult | null>(null);

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    const effectivePpm = pxPerMeter * zoom;
    const dx = (e.clientX - dragRef.current.startClientX) / effectivePpm;
    const dy = (e.clientY - dragRef.current.startClientY) / effectivePpm;
    const newX = dragRef.current.startX + dx;
    const newY = dragRef.current.startY + dy;
    setLocalX(newX);
    setLocalY(newY);
    if (onSnapDragMove) {
      snapResultRef.current = onSnapDragMove(`furniture-${placement.id}`, newX, newY, localW, localH);
    }
  };

  const snapValue = (val: number, step: number) => {
    const stepM = step / pxPerMeter;
    return Math.round(val / stepM) * stepM;
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    const effectivePpm = pxPerMeter * zoom;
    const dx = (e.clientX - dragRef.current.startClientX) / effectivePpm;
    const dy = (e.clientY - dragRef.current.startClientY) / effectivePpm;
    let newX = dragRef.current.startX + dx;
    let newY = dragRef.current.startY + dy;
    // Apply snap guide position if available
    const snap = snapResultRef.current;
    if (snap) {
      if (snap.snapX !== null) newX = snap.snapX;
      if (snap.snapY !== null) newY = snap.snapY;
      snapResultRef.current = null;
    } else if (snapEnabled && gridStepPx > 0) {
      newX = snapValue(newX, gridStepPx);
      newY = snapValue(newY, gridStepPx);
    }
    onSnapDragEnd?.();
    if (newX !== placement.x || newY !== placement.y) {
      onChange({ ...placement, x: newX, y: newY });
    }
  };

  // Resize handlers
  const handleResizeDragStart = (
    _e: React.PointerEvent,
    corner: "nw" | "ne" | "sw" | "se",
  ) => {
    resizeRef.current = {
      active: true,
      corner,
      startX: localX,
      startY: localY,
      startW: localW,
      startH: localH,
    };
  };

  const handleResizeDragMove = (dx: number, dy: number, corner: "nw" | "ne" | "sw" | "se") => {
    const dxM = dx / (pxPerMeter * zoom);
    const dyM = dy / (pxPerMeter * zoom);
    const ref = resizeRef.current;

    let newX = ref.startX;
    let newY = ref.startY;
    let newW = ref.startW;
    let newH = ref.startH;

    if (corner === "se") {
      newW = Math.max(minSizeM, ref.startW + dxM);
      newH = Math.max(minSizeM, ref.startH + dyM);
    } else if (corner === "sw") {
      const rawW = ref.startW - dxM;
      newW = Math.max(minSizeM, rawW);
      newX = rawW < minSizeM ? ref.startX + ref.startW - minSizeM : ref.startX + dxM;
      newH = Math.max(minSizeM, ref.startH + dyM);
    } else if (corner === "ne") {
      newW = Math.max(minSizeM, ref.startW + dxM);
      const rawH = ref.startH - dyM;
      newH = Math.max(minSizeM, rawH);
      newY = rawH < minSizeM ? ref.startY + ref.startH - minSizeM : ref.startY + dyM;
    } else if (corner === "nw") {
      const rawW = ref.startW - dxM;
      newW = Math.max(minSizeM, rawW);
      newX = rawW < minSizeM ? ref.startX + ref.startW - minSizeM : ref.startX + dxM;
      const rawH = ref.startH - dyM;
      newH = Math.max(minSizeM, rawH);
      newY = rawH < minSizeM ? ref.startY + ref.startH - minSizeM : ref.startY + dyM;
    }

    setLocalX(newX);
    setLocalY(newY);
    setLocalW(newW);
    setLocalH(newH);
  };

  const handleResizeDragEnd = (corner: "nw" | "ne" | "sw" | "se") => {
    resizeRef.current.active = false;
    onChange({
      ...placement,
      x: localX,
      y: localY,
      width: localW,
      height: localH,
    });
    void corner;
  };

  const colors = FURNITURE_COLORS[placement.type];
  const rotation = placement.rotation ?? 0;
  const showResizeHandles = selected && !placement.locked;

  return (
    <div
      className={`absolute border-2 ${colors.bg} ${
        selected
          ? placement.locked ? "border-white/40 dark:border-white/40" : "border-white dark:border-white"
          : colors.border
      } ${placement.locked ? "cursor-default" : "cursor-grab active:cursor-grabbing"}`}
      style={{
        left: localX * pxPerMeter,
        top: localY * pxPerMeter,
        width: localW * pxPerMeter,
        height: localH * pxPerMeter,
        transform: `rotate(${rotation}deg)`,
        transformOrigin: "center center",
        userSelect: "none",
        touchAction: "none",
        zIndex: 10,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <span className="pointer-events-none select-none px-1 text-[10px] font-semibold text-slate-700 dark:text-zinc-300 truncate block">
        {placement.label}
      </span>

      {showResizeHandles && (
        <>
          <ResizeHandle
            corner="nw"
            onDragStart={(e) => handleResizeDragStart(e, "nw")}
            onDragMove={(dx, dy) => handleResizeDragMove(dx, dy, "nw")}
            onDragEnd={() => handleResizeDragEnd("nw")}
          />
          <ResizeHandle
            corner="ne"
            onDragStart={(e) => handleResizeDragStart(e, "ne")}
            onDragMove={(dx, dy) => handleResizeDragMove(dx, dy, "ne")}
            onDragEnd={() => handleResizeDragEnd("ne")}
          />
          <ResizeHandle
            corner="sw"
            onDragStart={(e) => handleResizeDragStart(e, "sw")}
            onDragMove={(dx, dy) => handleResizeDragMove(dx, dy, "sw")}
            onDragEnd={() => handleResizeDragEnd("sw")}
          />
          <ResizeHandle
            corner="se"
            onDragStart={(e) => handleResizeDragStart(e, "se")}
            onDragMove={(dx, dy) => handleResizeDragMove(dx, dy, "se")}
            onDragEnd={() => handleResizeDragEnd("se")}
          />
        </>
      )}
    </div>
  );
}
