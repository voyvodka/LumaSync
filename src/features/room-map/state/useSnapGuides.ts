import { useCallback, useRef, useState } from "react";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import {
  computeSnap,
  getObjectRects,
  SNAP_THRESHOLD_M,
  type ObjectRect,
  type SnapGuide,
  type SnapResult,
} from "../model/snapGeometry";

export type { ObjectRect, SnapGuide, SnapResult };

export interface UseSnapGuidesReturn {
  guides: SnapGuide[];
  onDragMove: (id: string, x: number, y: number, w: number, h: number) => SnapResult;
  onDragEnd: () => void;
}

export function sameGuides(a: readonly SnapGuide[], b: readonly SnapGuide[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((g, i) => g.axis === b[i]?.axis && g.position === b[i]?.position);
}

/** The guides live in the editor, so every `setGuides` re-renders it. A drag
 *  calls `onDragMove` per pointer move and the guides change only when an edge
 *  enters or leaves a snap, so an unchanged list is not stored. */
export function useSnapGuides(config: RoomMapConfig): UseSnapGuidesReturn {
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const guidesRef = useRef<SnapGuide[]>(guides);
  const configRef = useRef(config);
  configRef.current = config;

  const publish = useCallback((next: SnapGuide[]) => {
    if (sameGuides(guidesRef.current, next)) return;
    guidesRef.current = next;
    setGuides(next);
  }, []);

  const onDragMove = useCallback(
    (id: string, x: number, y: number, w: number, h: number): SnapResult => {
      const others = getObjectRects(configRef.current, id);
      const dragging: ObjectRect = { id, x, y, w, h };
      const result = computeSnap(dragging, others, SNAP_THRESHOLD_M);
      publish(result.guides);
      return result;
    },
    [publish],
  );

  const onDragEnd = useCallback(() => {
    publish([]);
  }, [publish]);

  return { guides, onDragMove, onDragEnd };
}
