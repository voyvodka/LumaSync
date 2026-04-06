import { useRef } from "react";

type Corner = "nw" | "ne" | "sw" | "se";

interface ResizeHandleProps {
  corner: Corner;
  onDragStart: (e: React.PointerEvent) => void;
  onDragMove: (dx: number, dy: number) => void;
  onDragEnd: () => void;
}

const CORNER_CLASSES: Record<Corner, string> = {
  nw: "top-[-4px] left-[-4px] cursor-nwse-resize",
  ne: "top-[-4px] right-[-4px] cursor-nesw-resize",
  sw: "bottom-[-4px] left-[-4px] cursor-nesw-resize",
  se: "bottom-[-4px] right-[-4px] cursor-nwse-resize",
};

export function ResizeHandle({ corner, onDragStart, onDragMove, onDragEnd }: ResizeHandleProps) {
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { x: e.clientX, y: e.clientY };
    onDragStart(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;
    onDragMove(dx, dy);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    startRef.current = null;
    onDragEnd();
  };

  return (
    <div
      className={`absolute h-2 w-2 rounded-sm border border-slate-900 bg-white dark:border-zinc-100 dark:bg-zinc-950 ${CORNER_CLASSES[corner]}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  );
}
