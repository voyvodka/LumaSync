import { type PointerEvent, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { RoomCorner, RoomDimensions } from "@/shared/contracts/roomMap";

import {
  type FootprintShape,
  type FootprintSide,
  moveShapeTo,
  movableWalls,
  moveFootprintWall,
  notchAt,
  shapeGrip,
} from "../../model/roomFootprint";
import styles from "./FootprintWalls.module.css";

/** Thick enough to grab at any zoom, in screen pixels. */
const GRAB_PX = 12;

export interface FootprintWallsProps {
  corners: readonly RoomCorner[];
  dimensions: RoomDimensions;
  /** The outline in the editor's terms: an L, U or T gets a grip to move it and a × to remove it. */
  shape: FootprintShape;
  pxPerMeter: number;
  zoom: number;
  panMode: boolean;
  /** A wall moved by a drag; `gesture` keeps one drag one undo step. */
  onMove: (corners: RoomCorner[], gesture: string) => void;
  /** A notch cut into a plain room's wall by a double-click. */
  onNotch: (corners: RoomCorner[]) => void;
  /** An outer wall pulled out (positive) or in, by `delta` metres since the press. */
  onResizeStart: (side: FootprintSide) => void;
  onResize: (side: FootprintSide, delta: number, gesture: string) => void;
  /** The shape moved by its grip, or removed (`rect`). */
  onShapeChange: (shape: FootprintShape, gesture?: string) => void;
}

type Drag =
  | { kind: "inner"; index: number; axis: "x" | "y"; start: number; from: readonly RoomCorner[]; id: number }
  | { kind: "outer"; side: FootprintSide; startX: number; startY: number; id: number }
  | { kind: "grip"; from: FootprintShape; at: RoomCorner; startX: number; startY: number; id: number };

const OUTWARD: Record<FootprintSide, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/**
 * The outline's walls as handles on the plan. The room's four outer walls drag to resize it with
 * the opposite wall held; a wall inside the box drags along its normal to reshape it; on a plain
 * rectangle a double-click cuts a notch. A shaped room has a grip in its cut that slides it along
 * the walls or to another one, and a × beside it that puts the rectangle back. Pointer only — the
 * size fields and the Shape row in Room settings are the keyboard's way to the same, so these stay
 * hidden from assistive tech.
 */
export function FootprintWalls({
  corners,
  dimensions,
  shape,
  pxPerMeter,
  zoom,
  panMode,
  onMove,
  onNotch,
  onResizeStart,
  onResize,
  onShapeChange,
}: FootprintWallsProps) {
  const { t } = useTranslation();
  const drag = useRef<Drag | null>(null);
  const drags = useRef(0);
  const grab = GRAB_PX / zoom;
  const ppm = pxPerMeter * zoom;

  const capture = (event: PointerEvent<HTMLElement>) => {
    if (panMode || event.button !== 0) return false;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drags.current += 1;
    return true;
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "inner") {
      const now = d.axis === "x" ? event.clientX : event.clientY;
      const next = moveFootprintWall(d.from, dimensions, d.index, (now - d.start) / ppm);
      if (next) onMove(next, `footprint-wall:${d.id}`);
    } else if (d.kind === "outer") {
      const out = OUTWARD[d.side];
      const delta = ((event.clientX - d.startX) * out.x + (event.clientY - d.startY) * out.y) / ppm;
      onResize(d.side, delta, `room-wall:${d.id}`);
    } else {
      const p = { x: d.at.x + (event.clientX - d.startX) / ppm, y: d.at.y + (event.clientY - d.startY) / ppm };
      onShapeChange(moveShapeTo(d.from, dimensions, p), `room-shape:${d.id}`);
    }
  };
  const end = () => {
    drag.current = null;
  };
  const handlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end };

  const { widthMeters: w, depthMeters: h } = dimensions;
  const outer: { side: FootprintSide; left: number; top: number; width: number; height: number }[] = [
    { side: "top", left: 0, top: -grab / 2, width: w * pxPerMeter, height: grab },
    { side: "bottom", left: 0, top: h * pxPerMeter - grab / 2, width: w * pxPerMeter, height: grab },
    { side: "left", left: -grab / 2, top: 0, width: grab, height: h * pxPerMeter },
    { side: "right", left: w * pxPerMeter - grab / 2, top: 0, width: grab, height: h * pxPerMeter },
  ];
  const plain = corners.length === 4;
  const grip = plain ? null : shapeGrip(shape, dimensions);

  return (
    <div className={styles.layer} aria-hidden="true">
      {outer.map((s) => (
        <div
          key={s.side}
          className={s.side === "left" || s.side === "right" ? styles.plumb : styles.level}
          style={{ left: s.left, top: s.top, width: s.width, height: s.height }}
          title={plain ? t("roomMap:shape.resizeNotchHint") : t("roomMap:shape.resizeHint")}
          data-testid={`room-wall-${s.side}`}
          onPointerDown={(event) => {
            if (!capture(event)) return;
            drag.current = { kind: "outer", side: s.side, startX: event.clientX, startY: event.clientY, id: drags.current };
            onResizeStart(s.side);
          }}
          {...handlers}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => {
            if (panMode || !plain) return;
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            const vertical = s.side === "left" || s.side === "right";
            const fraction = vertical ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width;
            const next = notchAt(corners, dimensions, s.side, fraction * (vertical ? h : w));
            if (next) onNotch(next);
          }}
        />
      ))}
      {movableWalls(corners, dimensions).map((wall) => {
        const x0 = Math.min(wall.a.x, wall.b.x) * pxPerMeter;
        const y0 = Math.min(wall.a.y, wall.b.y) * pxPerMeter;
        const length = (wall.axis === "y" ? Math.abs(wall.a.x - wall.b.x) : Math.abs(wall.a.y - wall.b.y)) * pxPerMeter;
        const style =
          wall.axis === "y"
            ? { left: x0, top: y0 - grab / 2, width: length, height: grab }
            : { left: x0 - grab / 2, top: y0, width: grab, height: length };
        return (
          <div
            key={wall.index}
            className={wall.axis === "y" ? styles.level : styles.plumb}
            style={style}
            title={t("roomMap:shape.dragHint")}
            data-testid={`room-wall-${wall.index}`}
            onPointerDown={(event) => {
              if (!capture(event)) return;
              drag.current = {
                kind: "inner",
                index: wall.index,
                axis: wall.axis,
                start: wall.axis === "x" ? event.clientX : event.clientY,
                from: corners,
                id: drags.current,
              };
            }}
            {...handlers}
            onClick={(event) => event.stopPropagation()}
          />
        );
      })}
      {grip ? (
        <div
          className={styles.grip}
          style={{ left: grip.x * pxPerMeter, top: grip.y * pxPerMeter, ["--wall-scale" as string]: 1 / zoom }}
        >
          <span
            className={styles.move}
            title={t("roomMap:shape.moveHint")}
            data-testid="room-shape-grip"
            onPointerDown={(event) => {
              if (!capture(event)) return;
              drag.current = { kind: "grip", from: shape, at: grip, startX: event.clientX, startY: event.clientY, id: drags.current };
            }}
            {...handlers}
            onClick={(event) => event.stopPropagation()}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M8 1.5v13M1.5 8h13M8 1.5 6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <button
            type="button"
            tabIndex={-1}
            className={styles.remove}
            title={t("roomMap:shape.removeHint")}
            data-testid="room-shape-remove"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onShapeChange({ kind: "rect" });
            }}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ) : null}
    </div>
  );
}
