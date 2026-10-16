import { type RefObject, useCallback, useRef, useState } from "react";

/** What the 3D room has under the pointer, and a chip following it. Placed by ref, not state:
 *  only a new object under the pointer re-renders. */
export function useHoverChip(rootRef: RefObject<HTMLElement | null>) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const chip = useRef<HTMLDivElement | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const place = useCallback(() => {
    const root = rootRef.current;
    if (!root || !chip.current) return;
    const box = root.getBoundingClientRect();
    chip.current.style.transform = `translate(${pointer.current.x - box.left + 14}px, ${pointer.current.y - box.top - 30}px)`;
  }, [rootRef]);
  const onHover = useCallback(
    (objectId: string | null, x: number, y: number) => {
      pointer.current = { x, y };
      setHoveredId(objectId);
      place();
    },
    [place],
  );
  const chipRef = useCallback(
    (node: HTMLDivElement | null) => {
      chip.current = node;
      place();
    },
    [place],
  );
  return { hoveredId, onHover, chipRef };
}
