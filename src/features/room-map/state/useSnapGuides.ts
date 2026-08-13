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

export function useSnapGuides(config: RoomMapConfig): UseSnapGuidesReturn {
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const configRef = useRef(config);
  configRef.current = config;

  const onDragMove = useCallback(
    (id: string, x: number, y: number, w: number, h: number): SnapResult => {
      const others = getObjectRects(configRef.current, id);
      const dragging: ObjectRect = { id, x, y, w, h };
      const result = computeSnap(dragging, others, SNAP_THRESHOLD_M);
      setGuides(result.guides);
      return result;
    },
    [],
  );

  const onDragEnd = useCallback(() => {
    setGuides([]);
  }, []);

  return { guides, onDragMove, onDragEnd };
}
