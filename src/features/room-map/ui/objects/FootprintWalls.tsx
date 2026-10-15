import { type PointerEvent, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { RoomCorner, RoomDimensions } from "@/shared/contracts/roomMap";

import { type FootprintSide, movableWalls, moveFootprintWall, notchAt } from "../../model/roomFootprint";
import styles from "./FootprintWalls.module.css";

/** Thick enough to grab at any zoom, in screen pixels. */
const GRAB_PX = 12;

export interface FootprintWallsProps {
  corners: readonly RoomCorner[];
  dimensions: RoomDimensions;
  pxPerMeter: number;
  zoom: number;
  panMode: boolean;
  /** A wall moved by a drag; `gesture` keeps one drag one undo step. */
  onMove: (corners: RoomCorner[], gesture: string) => void;
  /** A notch cut into a plain room's wall by a double-click. */
  onNotch: (corners: RoomCorner[]) => void;
}

/**
 * The outline's own walls as handles on the plan: a wall inside the room's box drags along its
 * normal, and on a plain rectangle a double-click on a wall cuts a notch there. Pointer only — the
 * Shape row in Room settings is the keyboard's way to the same shapes, so these stay hidden from
 * assistive tech.
 */
export function FootprintWalls({ corners, dimensions, pxPerMeter, zoom, panMode, onMove, onNotch }: FootprintWallsProps) {
  const { t } = useTranslation();
  const drag = useRef<{ index: number; axis: "x" | "y"; start: number; from: readonly RoomCorner[]; id: number } | null>(null);
  const drags = useRef(0);
  const grab = GRAB_PX / zoom;

  const begin = (event: PointerEvent<HTMLDivElement>, index: number, axis: "x" | "y") => {
    if (panMode || event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drags.current += 1;
    drag.current = { index, axis, start: axis === "x" ? event.clientX : event.clientY, from: corners, id: drags.current };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const now = d.axis === "x" ? event.clientX : event.clientY;
    const next = moveFootprintWall(d.from, dimensions, d.index, (now - d.start) / zoom / pxPerMeter);
    if (next) onMove(next, `footprint-wall:${d.id}`);
  };
  const end = () => {
    drag.current = null;
  };

  if (corners.length === 4) {
    const { widthMeters: w, depthMeters: h } = dimensions;
    const sides: { side: FootprintSide; left: number; top: number; width: number; height: number }[] = [
      { side: "top", left: 0, top: -grab / 2, width: w * pxPerMeter, height: grab },
      { side: "bottom", left: 0, top: h * pxPerMeter - grab / 2, width: w * pxPerMeter, height: grab },
      { side: "left", left: -grab / 2, top: 0, width: grab, height: h * pxPerMeter },
      { side: "right", left: w * pxPerMeter - grab / 2, top: 0, width: grab, height: h * pxPerMeter },
    ];
    return (
      <div className={styles.layer} aria-hidden="true">
        {sides.map((s) => (
          <div
            key={s.side}
            className={styles.edge}
            style={{ left: s.left, top: s.top, width: s.width, height: s.height }}
            title={t("roomMap:shape.notchHint")}
            data-testid={`room-wall-${s.side}`}
            onDoubleClick={(event) => {
              if (panMode) return;
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              const vertical = s.side === "left" || s.side === "right";
              const fraction = vertical ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width;
              const along = fraction * (vertical ? h : w);
              const next = notchAt(corners, dimensions, s.side, along);
              if (next) onNotch(next);
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={styles.layer} aria-hidden="true">
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
            onPointerDown={(event) => begin(event, wall.index, wall.axis)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onClick={(event) => event.stopPropagation()}
          />
        );
      })}
    </div>
  );
}
