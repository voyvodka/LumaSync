import { useEffect, useRef } from "react";

import { pastSlop, useEscapeCancels } from "./dragIntent";

type Corner = "nw" | "ne" | "sw" | "se";

interface ResizeHandleProps {
  corner: Corner;
  onDragStart: (e: React.PointerEvent) => void;
  onDragMove: (dx: number, dy: number) => void;
  onDragEnd: () => void;
  /** A press that never moved, Esc, a cancelled pointer or the handle going away mid-drag. */
  onDragCancel: () => void;
}

const CORNER_CLASSES: Record<Corner, string> = {
  nw: "top-[-4px] left-[-4px] cursor-nwse-resize",
  ne: "top-[-4px] right-[-4px] cursor-nesw-resize",
  sw: "bottom-[-4px] left-[-4px] cursor-nesw-resize",
  se: "bottom-[-4px] right-[-4px] cursor-nwse-resize",
};

export function ResizeHandle({ corner, onDragStart, onDragMove, onDragEnd, onDragCancel }: ResizeHandleProps) {
  const startRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const cancelRef = useRef(onDragCancel);
  cancelRef.current = onDragCancel;
  const cancel = () => {
    if (!startRef.current) return;
    startRef.current = null;
    cancelRef.current();
  };
  useEscapeCancels(() => startRef.current !== null, cancel);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on unmount, through the refs.
  useEffect(() => () => cancel(), []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { x: e.clientX, y: e.clientY, moved: false };
    onDragStart(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    if (!startRef.current.moved && !pastSlop(startRef.current.x, startRef.current.y, e.clientX, e.clientY)) return;
    startRef.current.moved = true;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;
    onDragMove(dx, dy);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    // A press that never left the handle resizes nothing, but its start must still be let go.
    if (!startRef.current?.moved) {
      cancel();
      return;
    }
    startRef.current = null;
    onDragEnd();
  };

  return (
    <div
      className={`absolute h-2 w-2 rounded-sm border border-zinc-100 bg-zinc-950 ${CORNER_CLASSES[corner]}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={cancel}
    />
  );
}
