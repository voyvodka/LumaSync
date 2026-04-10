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
    const θ = (placement.rotation ?? 0) * (Math.PI / 180);
    const cosT = Math.cos(θ);
    const sinT = Math.sin(θ);
    const ref = resizeRef.current;

    // Rotate screen delta into object's local coordinate system
    const localDx = (dx * cosT + dy * sinT) / (pxPerMeter * zoom);
    const localDy = (-dx * sinT + dy * cosT) / (pxPerMeter * zoom);

    // Compute new width/height based on which corner is being dragged
    let newW = ref.startW;
    let newH = ref.startH;
    if (corner === "se") {
      newW = Math.max(minSizeM, ref.startW + localDx);
      newH = Math.max(minSizeM, ref.startH + localDy);
    } else if (corner === "sw") {
      newW = Math.max(minSizeM, ref.startW - localDx);
      newH = Math.max(minSizeM, ref.startH + localDy);
    } else if (corner === "ne") {
      newW = Math.max(minSizeM, ref.startW + localDx);
      newH = Math.max(minSizeM, ref.startH - localDy);
    } else if (corner === "nw") {
      newW = Math.max(minSizeM, ref.startW - localDx);
      newH = Math.max(minSizeM, ref.startH - localDy);
    }

    // Keep the opposite (anchor) corner fixed in world space.
    // CSS model: element at (x,y), then rotated around its center.
    // World pos of a corner = center + rotate(localOffset, θ)
    const anchor = { se: "nw", ne: "sw", sw: "ne", nw: "se" }[corner] as typeof corner;
    const aOldLx = (anchor === "ne" || anchor === "se") ? ref.startW / 2 : -ref.startW / 2;
    const aOldLy = (anchor === "sw" || anchor === "se") ? ref.startH / 2 : -ref.startH / 2;
    const origCx = ref.startX + ref.startW / 2;
    const origCy = ref.startY + ref.startH / 2;
    const anchorWx = origCx + aOldLx * cosT - aOldLy * sinT;
    const anchorWy = origCy + aOldLx * sinT + aOldLy * cosT;

    // Anchor's local offset in the new dimensions
    const aNewLx = (anchor === "ne" || anchor === "se") ? newW / 2 : -newW / 2;
    const aNewLy = (anchor === "sw" || anchor === "se") ? newH / 2 : -newH / 2;
    // New center = anchorWorld - rotate(newAnchorLocal, θ)
    const newCx = anchorWx - (aNewLx * cosT - aNewLy * sinT);
    const newCy = anchorWy - (aNewLx * sinT + aNewLy * cosT);

    setLocalX(newCx - newW / 2);
    setLocalY(newCy - newH / 2);
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
