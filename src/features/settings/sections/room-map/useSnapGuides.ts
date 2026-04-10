import { useCallback, useRef, useState } from "react";
import type { RoomMapConfig } from "../../../../shared/contracts/roomMap";

export interface ObjectRect {
  id: string;
  x: number; // meters, top-left
  y: number;
  w: number;
  h: number;
}

export interface SnapGuide {
  axis: "x" | "y";
  position: number; // meters
}

export interface SnapResult {
  snapX: number | null; // snapped x position (meters), null if no snap
  snapY: number | null;
  guides: SnapGuide[];
}

const SNAP_THRESHOLD_M = 0.08; // ~5px at typical zoom

function getObjectRects(config: RoomMapConfig, excludeId: string): ObjectRect[] {
  const rects: ObjectRect[] = [];

  if (config.tvAnchor && excludeId !== "tv") {
    const tv = config.tvAnchor;
    rects.push({ id: "tv", x: tv.x, y: tv.y, w: tv.width, h: tv.height });
  }

  for (const f of config.furniture) {
    const fId = `furniture-${f.id}`;
    if (fId === excludeId) continue;
    rects.push({ id: fId, x: f.x, y: f.y, w: f.width, h: f.height });
  }

  // Origin (room center) as a zero-size rect so objects snap to it
  const ox = config.dimensions.widthMeters / 2;
  const oy = config.dimensions.depthMeters / 2;
  rects.push({ id: "__origin", x: ox, y: oy, w: 0, h: 0 });

  return rects;
}

function computeSnap(
  dragging: ObjectRect,
  others: ObjectRect[],
  threshold: number,
): SnapResult {
  const guides: SnapGuide[] = [];
  let snapX: number | null = null;
  let snapY: number | null = null;
  let bestDx = threshold;
  let bestDy = threshold;

  const dragCx = dragging.x + dragging.w / 2;
  const dragCy = dragging.y + dragging.h / 2;
  const dragRight = dragging.x + dragging.w;
  const dragBottom = dragging.y + dragging.h;

  for (const other of others) {
    const otherCx = other.x + other.w / 2;
    const otherCy = other.y + other.h / 2;
    const otherRight = other.x + other.w;
    const otherBottom = other.y + other.h;

    // X-axis alignments: left-left, right-right, center-center, left-right, right-left
    const xPairs: [number, number][] = [
      [dragging.x, other.x],          // left ↔ left
      [dragRight, otherRight],          // right ↔ right
      [dragCx, otherCx],               // center ↔ center
      [dragging.x, otherRight],         // left ↔ right
      [dragRight, other.x],             // right ↔ left
    ];

    for (const [dragVal, otherVal] of xPairs) {
      const diff = Math.abs(dragVal - otherVal);
      if (diff < bestDx) {
        bestDx = diff;
        snapX = dragging.x + (otherVal - dragVal);
        guides.length = 0; // reset — we found a closer match
        guides.push({ axis: "x", position: otherVal });
      } else if (diff === bestDx && snapX !== null) {
        guides.push({ axis: "x", position: otherVal });
      }
    }

    // Y-axis alignments: top-top, bottom-bottom, center-center, top-bottom, bottom-top
    const yPairs: [number, number][] = [
      [dragging.y, other.y],
      [dragBottom, otherBottom],
      [dragCy, otherCy],
      [dragging.y, otherBottom],
      [dragBottom, other.y],
    ];

    for (const [dragVal, otherVal] of yPairs) {
      const diff = Math.abs(dragVal - otherVal);
      if (diff < bestDy) {
        bestDy = diff;
        snapY = dragging.y + (otherVal - dragVal);
        // Only reset Y guides
        const xGuides = guides.filter((g) => g.axis === "x");
        guides.length = 0;
        guides.push(...xGuides);
        guides.push({ axis: "y", position: otherVal });
      } else if (diff === bestDy && snapY !== null) {
        guides.push({ axis: "y", position: otherVal });
      }
    }
  }

  if (bestDx >= threshold) snapX = null;
  if (bestDy >= threshold) snapY = null;

  return { snapX, snapY, guides };
}

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
