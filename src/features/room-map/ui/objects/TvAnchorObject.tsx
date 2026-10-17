import { memo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TvAnchorPlacement } from "@/shared/contracts/roomMap";
import { ResizeHandle } from "./ResizeHandle";
import { clampInsideRoom, type RoomBox } from "../../model/pieceGeometry";
import { markDragging, stillAClick, useEscapeCancels } from "./dragIntent";
import type { SnapResult } from "../../state/useSnapGuides";

const MIN_SIZE_PX = 24;

interface TvAnchorObjectProps {
  placement: TvAnchorPlacement;
  pxPerMeter: number;
  selected: boolean;
  gridStepPx: number;
  snapEnabled: boolean;
  zoom?: number;
  panMode?: boolean;
  /** The room's box: a drag stops at its walls. */
  room?: RoomBox;
  onSelect: () => void;
  onChange: (updated: TvAnchorPlacement) => void;
  onSnapDragMove?: (id: string, x: number, y: number, w: number, h: number) => SnapResult;
  onSnapDragEnd?: () => void;
  /** In a selection with others: dragging the TV moves them all, and they follow it meanwhile. */
  grouped?: boolean;
  onGroupDragMove?: (dx: number, dy: number) => void;
  onGroupDragEnd?: (dx: number, dy: number) => void;
}

export const TvAnchorObject = memo(function TvAnchorObject({
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
  room,
  grouped = false,
  onGroupDragMove,
  onGroupDragEnd,
}: TvAnchorObjectProps) {
  const { t } = useTranslation();
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
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  }>({ active: false, startX: 0, startY: 0, startW: 0, startH: 0 });

  const minSizeM = MIN_SIZE_PX / pxPerMeter;

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (resizeRef.current.active) return;
    if (panMode) return;
    onSelect();
    if (placement.locked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      active: true,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: localX,
      startY: localY,
    };
    tvRef.current = e.currentTarget;
  };
  const tvRef = useRef<HTMLDivElement | null>(null);
  const inRoom = (x: number, y: number) => {
    if (!room) return { x, y };
    const box = clampInsideRoom({ x, y, w: localW, h: localH, r: 0 }, room);
    return { x: box.x, y: box.y };
  };

  const snapResultRef = useRef<SnapResult | null>(null);

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    if (stillAClick(tvRef.current, dragRef.current.startClientX, dragRef.current.startClientY, e.clientX, e.clientY)) return;
    markDragging(tvRef.current, true);
    const effectivePpm = pxPerMeter * zoom;
    const { x: newX, y: newY } = inRoom(
      dragRef.current.startX + (e.clientX - dragRef.current.startClientX) / effectivePpm,
      dragRef.current.startY + (e.clientY - dragRef.current.startClientY) / effectivePpm,
    );
    setLocalX(newX);
    setLocalY(newY);
    onGroupDragMove?.(newX - dragRef.current.startX, newY - dragRef.current.startY);
    if (onSnapDragMove) {
      snapResultRef.current = onSnapDragMove("tv", newX, newY, localW, localH);
    }
  };

  const snapValue = (val: number, step: number) => {
    const stepM = step / pxPerMeter;
    return Math.round(val / stepM) * stepM;
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    const carried = !!tvRef.current?.hasAttribute("data-dragging");
    markDragging(tvRef.current, false);
    if (!carried) {
      snapResultRef.current = null;
      onSnapDragEnd?.();
      setLocalX(placement.x);
      setLocalY(placement.y);
      onGroupDragEnd?.(0, 0);
      return;
    }
    const effectivePpm = pxPerMeter * zoom;
    const unsnapped = inRoom(
      dragRef.current.startX + (e.clientX - dragRef.current.startClientX) / effectivePpm,
      dragRef.current.startY + (e.clientY - dragRef.current.startClientY) / effectivePpm,
    );
    let newX = unsnapped.x;
    let newY = unsnapped.y;
    const snap = snapResultRef.current;
    snapResultRef.current = null;
    // Per axis: a guide wins where it caught, the grid holds the other.
    const onGrid = snapEnabled && gridStepPx > 0;
    newX = snap?.snapX ?? (onGrid ? snapValue(newX, gridStepPx) : newX);
    newY = snap?.snapY ?? (onGrid ? snapValue(newY, gridStepPx) : newY);
    newX = Math.round(newX * 100) / 100;
    newY = Math.round(newY * 100) / 100;
    onSnapDragEnd?.();
    if (onGroupDragEnd) {
      onGroupDragEnd(newX - dragRef.current.startX, newY - dragRef.current.startY);
      return;
    }
    if (newX !== placement.x || newY !== placement.y) {
      onChange({ ...placement, x: newX, y: newY });
    }
  };

  // A drag the system took away (a gesture, a dialog) puts the TV back where it was.
  const cancelDrag = () => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    markDragging(tvRef.current, false);
    snapResultRef.current = null;
    onSnapDragEnd?.();
    setLocalX(placement.x);
    setLocalY(placement.y);
    onGroupDragEnd?.(0, 0);
  };
  useEscapeCancels(() => dragRef.current.active, cancelDrag);

  // Resize handlers
  const handleResizeDragStart = (_e: React.PointerEvent) => {
    resizeRef.current = {
      active: true,
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

  const handleResizeDragCancel = () => {
    resizeRef.current.active = false;
    setLocalX(placement.x);
    setLocalY(placement.y);
    setLocalW(placement.width);
    setLocalH(placement.height);
  };

  const handleResizeDragEnd = () => {
    resizeRef.current.active = false;
    onChange({
      ...placement,
      x: localX,
      y: localY,
      width: localW,
      height: localH,
    });
  };

  return (
    <div
      data-object-id="tv"
      className={`absolute border-2 bg-violet-500/40 ${grouped && !selected ? "outline-dashed outline-[1.5px] outline-offset-2 outline-amber" : ""} ${
        selected
          ? placement.locked ? "border-white/40" : "border-white"
          : "border-violet-500"
      } ${placement.locked ? "cursor-default" : "cursor-grab active:cursor-grabbing"} flex items-center justify-center`}
      style={{
        left: localX * pxPerMeter,
        top: localY * pxPerMeter,
        width: localW * pxPerMeter,
        height: localH * pxPerMeter,
        userSelect: "none",
        touchAction: "none",
        zIndex: 10,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={cancelDrag}
      onLostPointerCapture={cancelDrag}
    >
      <span className="pointer-events-none select-none text-[11px] font-semibold text-violet-300">
        {t("roomMap:objectPanel.tvLabel")}
      </span>

      {selected && !placement.locked && (
        <>
          <ResizeHandle
            corner="nw"
            onDragStart={(e) => handleResizeDragStart(e)}
            onDragMove={(dx, dy) => handleResizeDragMove(dx, dy, "nw")}
            onDragEnd={handleResizeDragEnd}
            onDragCancel={handleResizeDragCancel}
          />
          <ResizeHandle
            corner="ne"
            onDragStart={(e) => handleResizeDragStart(e)}
            onDragMove={(dx, dy) => handleResizeDragMove(dx, dy, "ne")}
            onDragEnd={handleResizeDragEnd}
            onDragCancel={handleResizeDragCancel}
          />
          <ResizeHandle
            corner="sw"
            onDragStart={(e) => handleResizeDragStart(e)}
            onDragMove={(dx, dy) => handleResizeDragMove(dx, dy, "sw")}
            onDragEnd={handleResizeDragEnd}
            onDragCancel={handleResizeDragCancel}
          />
          <ResizeHandle
            corner="se"
            onDragStart={(e) => handleResizeDragStart(e)}
            onDragMove={(dx, dy) => handleResizeDragMove(dx, dy, "se")}
            onDragEnd={handleResizeDragEnd}
            onDragCancel={handleResizeDragCancel}
          />
        </>
      )}
    </div>
  );
});
