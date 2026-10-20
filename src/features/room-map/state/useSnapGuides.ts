import { useCallback, useRef, useState } from "react";
import { usePreference } from "@/features/persistence/preferences";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import {
  computeSnap,
  getObjectRects,
  SNAP_ENGAGE_PX,
  SNAP_RELEASE_PX,
  snapReach,
  type ObjectRect,
  type SnapGuide,
  type SnapHold,
  type SnapResult,
} from "../model/snapGeometry";

export type { ObjectRect, SnapGuide, SnapResult };

export interface SnapDragExtra {
  r?: number;
  free?: boolean;
}

export interface UseSnapGuidesReturn {
  guides: SnapGuide[];
  /** A piece is being dragged now: the plan shows its grid more strongly meanwhile. */
  dragging: boolean;
  onDragMove: (id: string, x: number, y: number, w: number, h: number, extra?: SnapDragExtra) => SnapResult;
  onDragEnd: () => void;
}

const NO_SNAP: SnapResult = { snapX: null, snapY: null, guides: [] };

export function sameGuides(a: readonly SnapGuide[], b: readonly SnapGuide[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((g, i) => g.axis === b[i]?.axis && g.position === b[i]?.position && g.kind === b[i]?.kind && g.at === b[i]?.at);
}

/** The guides live in the editor, so every `setGuides` re-renders it. A drag
 *  calls `onDragMove` per pointer move and the guides change only when an edge
 *  enters or leaves a snap, so an unchanged list is not stored.
 *  `metresPerPx` turns the screen radii into the plan's metres at the current zoom. */
export function useSnapGuides(config: RoomMapConfig, metresPerPx = 1 / 80): UseSnapGuidesReturn {
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [dragging, setDragging] = useState(false);
  const enabled = usePreference("roomMapSnapToObjects");
  const draggingRef = useRef(false);
  const guidesRef = useRef<SnapGuide[]>(guides);
  const holdRef = useRef<SnapHold>({});
  const live = useRef({ config, metresPerPx, enabled });
  live.current = { config, metresPerPx, enabled };

  const publish = useCallback((next: SnapGuide[]) => {
    if (sameGuides(guidesRef.current, next)) return;
    guidesRef.current = next;
    setGuides(next);
  }, []);

  const onDragMove = useCallback(
    (id: string, x: number, y: number, w: number, h: number, extra: SnapDragExtra = {}): SnapResult => {
      if (!draggingRef.current) {
        draggingRef.current = true;
        setDragging(true);
      }
      const { config: current, metresPerPx: mpp, enabled: on } = live.current;
      if (!on || extra.free) {
        holdRef.current = {};
        publish([]);
        return NO_SNAP;
      }
      const dragged: ObjectRect = extra.r ? { id, x, y, w, h, r: extra.r } : { id, x, y, w, h };
      const result = computeSnap(dragged, getObjectRects(current, id), snapReach(SNAP_ENGAGE_PX, mpp), {
        release: snapReach(SNAP_RELEASE_PX, mpp),
        hold: holdRef.current,
      });
      holdRef.current = result.hold;
      publish(result.guides);
      return result;
    },
    [publish],
  );

  const onDragEnd = useCallback(() => {
    holdRef.current = {};
    publish([]);
    if (draggingRef.current) {
      draggingRef.current = false;
      setDragging(false);
    }
  }, [publish]);

  return { guides, dragging, onDragMove, onDragEnd };
}
