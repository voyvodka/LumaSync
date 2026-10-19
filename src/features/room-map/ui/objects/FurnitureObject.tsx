import { memo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type FurnitureModel, furnitureColours } from "@/features/room-view/model/furnitureModel";
import type { FurniturePlacement } from "@/shared/contracts/roomMap";
import { cx } from "@/shared/lib/cx";
import { FurnitureGlyph } from "./FurnitureGlyph";
import styles from "./FurnitureObject.module.css";
import { type FrameHandle, handleSigns, SelectionFrame } from "./SelectionFrame";
import { furnitureName } from "../../model/furnitureName";
import { furnitureObjectId } from "../../model/objectId";
import { clampInsideRoom, resizeFromHandle, snapToStep } from "../../model/pieceGeometry";
import { markDragging, stillAClick, useEscapeCancels } from "./dragIntent";
import { SNAP_ENGAGE_PX } from "../../model/snapGeometry";
import type { SnapDragExtra, SnapResult } from "../../state/useSnapGuides";

const MIN_SIZE_PX = 24;
/** Sizes land on 5 cm, whatever the grid. */
const RESIZE_STEP_M = 0.05;

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
  /** One of several selected pieces: dragging it moves them all, through `onGroupDrag*`. */
  grouped?: boolean;
  onGroupDragMove?: (dx: number, dy: number) => void;
  onGroupDragEnd?: (dx: number, dy: number) => void;
  /** `additive`: ⇧ was held, so the piece joins or leaves the selection. */
  onSelect: (id: string, additive?: boolean) => void;
  onChange: (updated: FurniturePlacement) => void;
  onSnapDragMove?: (id: string, x: number, y: number, w: number, h: number, extra?: SnapDragExtra) => SnapResult;
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
  grouped = false,
  onGroupDragMove,
  onGroupDragEnd,
}: FurnitureObjectProps) {
  const { t } = useTranslation();
  const name = furnitureName(placement, t);
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

  const pieceRef = useRef<HTMLDivElement | null>(null);
  useEscapeCancels(
    () => dragRef.current.active,
    () => finishDrag(null),
  );

  /** Where a drag puts the piece: inside the room, on the guide it meets, else on the grid (⌥ free). */
  const dragTarget = (clientX: number, clientY: number, free: boolean) => {
    const ppm = pxPerMeter * zoom;
    const d = dragRef.current;
    const raw = clampInsideRoom(
      { x: d.startX + (clientX - d.startClientX) / ppm, y: d.startY + (clientY - d.startClientY) / ppm, w: local.w, h: local.h, r: local.r },
      room,
    );
    const snap = onSnapDragMove?.(furnitureObjectId(placement.id), raw.x, raw.y, local.w, local.h, { r: local.r, free }) ?? null;
    if (free) return raw;
    // A grid line catches only as close as a guide does; snapping to every step jumped half a metre.
    const reach = SNAP_ENGAGE_PX / ppm;
    const soft = (value: number) => {
      if (!snapEnabled || gridStepM <= 0) return value;
      const onLine = snapToStep(value, gridStepM);
      return Math.abs(onLine - value) <= reach ? onLine : value;
    };
    // Per axis: a guide wins where it caught, a nearby grid line holds the other.
    const x = snap?.snapX ?? soft(raw.x);
    const y = snap?.snapY ?? soft(raw.y);
    return clampInsideRoom({ x, y, w: local.w, h: local.h, r: local.r }, room);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (panMode) return; // Let event bubble up for canvas pan
    onSelect(placement.id, e.shiftKey);
    if (placement.locked || e.shiftKey) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { active: true, startClientX: e.clientX, startClientY: e.clientY, startX: local.x, startY: local.y };
    pieceRef.current = e.currentTarget;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    if (stillAClick(pieceRef.current, dragRef.current.startClientX, dragRef.current.startClientY, e.clientX, e.clientY)) return;
    markDragging(pieceRef.current, true);
    const next = dragTarget(e.clientX, e.clientY, e.altKey);
    setLocal((current) => ({ ...current, x: next.x, y: next.y }));
    onGroupDragMove?.(next.x - dragRef.current.startX, next.y - dragRef.current.startY);
  };

  const finishDrag = (commit: { clientX: number; clientY: number; free: boolean } | null) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    const carried = !!pieceRef.current?.hasAttribute("data-dragging");
    markDragging(pieceRef.current, false);
    const d = dragRef.current;
    if (commit === null || !carried) {
      onSnapDragEnd?.();
      setLocal((current) => ({ ...current, x: placement.x, y: placement.y }));
      onGroupDragEnd?.(0, 0);
      return;
    }
    const next = dragTarget(commit.clientX, commit.clientY, commit.free);
    onSnapDragEnd?.();
    if (onGroupDragEnd) {
      onGroupDragEnd(next.x - d.startX, next.y - d.startY);
      return;
    }
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
      step: RESIZE_STEP_M,
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
          grouped && !selected && styles.grouped,
        )}
        data-furniture-id={placement.id}
        data-object-id={furnitureObjectId(placement.id)}
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
            {name}
          </span>
        )}
      </div>
      {selected ? (
        <SelectionFrame
          {...px}
          rotation={local.r}
          label={name}
          editable={!placement.locked}
          zoom={zoom}
          onResizeStart={handleResizeStart}
          onResizeMove={handleResizeMove}
          onResizeEnd={handleResizeEnd}
          onRotateStart={() => {}}
          onRotateMove={handleRotateMove}
          onRotateEnd={handleRotateEnd}
          onCancel={() => setLocal({ x: placement.x, y: placement.y, w: placement.width, h: placement.height, r: placement.rotation ?? 0 })}
        />
      ) : null}
    </>
  );
});
