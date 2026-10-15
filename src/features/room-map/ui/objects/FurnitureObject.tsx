import { memo, useRef, useState } from "react";
import { type FurnitureModel, furnitureColours } from "@/features/room-view/model/furnitureModel";
import type { FurniturePlacement } from "@/shared/contracts/roomMap";
import { cx } from "@/shared/lib/cx";
import { FurnitureGlyph } from "./FurnitureGlyph";
import styles from "./FurnitureObject.module.css";
import { type FrameHandle, handleSigns, SelectionFrame } from "./SelectionFrame";
import { furnitureObjectId } from "../../model/objectId";
import { clampInsideRoom, resizeFromHandle, snapToStep } from "../../model/pieceGeometry";
import { isClick } from "../../model/snapGeometry";
import type { SnapResult } from "../../state/useSnapGuides";

const MIN_SIZE_PX = 24;

interface FurnitureObjectProps {
  placement: FurniturePlacement;
  /** What the piece reads as — drawn from above as the 3D room builds it. */
  model: FurnitureModel;
  pxPerMeter: number;
  selected: boolean;
  /** Its middle sits outside the room's outline: marked, never refused. */
  outside?: boolean;
  /** The room's box: a dragged piece stays inside it. */
  roomWidth: number;
  roomDepth: number;
  gridStepPx: number;
  snapEnabled: boolean;
  zoom?: number;
  panMode?: boolean;
  onSelect: (id: string) => void;
  onChange: (updated: FurniturePlacement) => void;
  onSnapDragMove?: (id: string, x: number, y: number, w: number, h: number) => SnapResult;
  onSnapDragEnd?: () => void;
}

export const FurnitureObject = memo(function FurnitureObject({
  placement,
  model,
  pxPerMeter,
  selected,
  outside = false,
  roomWidth,
  roomDepth,
  gridStepPx,
  snapEnabled,
  onSelect,
  onChange,
  onSnapDragMove,
  onSnapDragEnd,
  zoom = 1,
  panMode = false,
}: FurnitureObjectProps) {
  const [local, setLocal] = useState(() => ({
    x: placement.x,
    y: placement.y,
    w: placement.width,
    h: placement.height,
    r: placement.rotation ?? 0,
  }));

  // Sync local state when placement prop changes from outside
  const prevPlacement = useRef(placement);
  if (prevPlacement.current !== placement) {
    prevPlacement.current = placement;
    setLocal({ x: placement.x, y: placement.y, w: placement.width, h: placement.height, r: placement.rotation ?? 0 });
  }

  const dragRef = useRef<{ active: boolean; startClientX: number; startClientY: number; startX: number; startY: number }>({
    active: false,
    startClientX: 0,
    startClientY: 0,
    startX: 0,
    startY: 0,
  });
  const gestureStart = useRef(local);
  const latest = useRef(local);
  latest.current = local;

  const minSizeM = MIN_SIZE_PX / pxPerMeter;
  const gridStepM = gridStepPx / pxPerMeter;
  const room = { width: roomWidth, depth: roomDepth };

  /** Where a drag puts the piece: inside the room, on the guide it meets, else on the grid (⌥ free). */
  const dragTarget = (clientX: number, clientY: number, free: boolean) => {
    const ppm = pxPerMeter * zoom;
    const d = dragRef.current;
    const raw = clampInsideRoom(
      { x: d.startX + (clientX - d.startClientX) / ppm, y: d.startY + (clientY - d.startClientY) / ppm, w: local.w, h: local.h, r: local.r },
      room,
    );
    const snap = onSnapDragMove?.(furnitureObjectId(placement.id), raw.x, raw.y, local.w, local.h) ?? null;
    if (free) return raw;
    const onGrid = snapEnabled && gridStepM > 0;
    // Per axis: a guide wins where it caught, the grid holds the other — it used to drop the grid on both.
    const x = snap?.snapX ?? (onGrid ? snapToStep(raw.x, gridStepM) : raw.x);
    const y = snap?.snapY ?? (onGrid ? snapToStep(raw.y, gridStepM) : raw.y);
    return clampInsideRoom({ x, y, w: local.w, h: local.h, r: local.r }, room);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (panMode) return; // Let event bubble up for canvas pan
    onSelect(placement.id);
    if (placement.locked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { active: true, startClientX: e.clientX, startClientY: e.clientY, startX: local.x, startY: local.y };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    if (isClick(dragRef.current.startClientX, dragRef.current.startClientY, e.clientX, e.clientY)) return;
    const next = dragTarget(e.clientX, e.clientY, e.altKey);
    setLocal((current) => ({ ...current, x: next.x, y: next.y }));
  };

  const finishDrag = (commit: { clientX: number; clientY: number; free: boolean } | null) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    const d = dragRef.current;
    if (commit === null || isClick(d.startClientX, d.startClientY, commit.clientX, commit.clientY)) {
      onSnapDragEnd?.();
      setLocal((current) => ({ ...current, x: placement.x, y: placement.y }));
      return;
    }
    const next = dragTarget(commit.clientX, commit.clientY, commit.free);
    onSnapDragEnd?.();
    const x = Math.round(next.x * 100) / 100;
    const y = Math.round(next.y * 100) / 100;
    if (x !== placement.x || y !== placement.y) onChange({ ...placement, x, y });
  };

  const handleResizeStart = () => {
    gestureStart.current = latest.current;
  };
  const handleResizeMove = (handle: FrameHandle, dx: number, dy: number, keepRatio: boolean) => {
    const start = gestureStart.current;
    const ppm = pxPerMeter * zoom;
    const next = resizeFromHandle(start, handleSigns(handle), dx / ppm, dy / ppm, {
      min: minSizeM,
      step: snapEnabled ? gridStepM : 0,
      keepRatio,
    });
    setLocal(next);
  };
  const handleResizeEnd = () => {
    const l = latest.current;
    const round = (v: number) => Math.round(v * 100) / 100;
    onChange({ ...placement, x: round(l.x), y: round(l.y), width: round(l.w), height: round(l.h) });
  };

  const handleRotateMove = (rotation: number) => setLocal((current) => ({ ...current, r: rotation }));
  const handleRotateEnd = () => {
    const r = latest.current.r;
    if (r !== (placement.rotation ?? 0)) onChange({ ...placement, rotation: r });
  };

  const px = {
    left: local.x * pxPerMeter,
    top: local.y * pxPerMeter,
    width: local.w * pxPerMeter,
    height: local.h * pxPerMeter,
  };

  return (
    <>
      <div
        className={cx(
          styles.piece,
          placement.locked ? "cursor-default" : "cursor-grab active:cursor-grabbing",
          outside && styles.outside,
        )}
        data-furniture-id={placement.id}
        data-selected={selected || undefined}
        data-outside={outside || undefined}
        style={{ ...px, transform: `rotate(${local.r}deg)` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => finishDrag({ clientX: e.clientX, clientY: e.clientY, free: e.altKey })}
        onPointerCancel={() => finishDrag(null)}
        onLostPointerCapture={() => finishDrag(null)}
      >
        <FurnitureGlyph model={model} colours={furnitureColours(placement, model)} width={local.w} depth={local.h} />
        {selected ? null : (
          <span className={styles.label} style={{ transform: `rotate(${-local.r}deg)` }}>
            {placement.label}
          </span>
        )}
      </div>
      {selected ? (
        <SelectionFrame
          {...px}
          rotation={local.r}
          label={placement.label}
          editable={!placement.locked}
          zoom={zoom}
          onResizeStart={handleResizeStart}
          onResizeMove={handleResizeMove}
          onResizeEnd={handleResizeEnd}
          onRotateStart={() => {}}
          onRotateMove={handleRotateMove}
          onRotateEnd={handleRotateEnd}
        />
      ) : null}
    </>
  );
});
