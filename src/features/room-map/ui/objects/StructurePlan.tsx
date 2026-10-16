import { useMemo } from "react";

import { type RoomMapConfig, type RoomStructure, STRUCTURE_KINDS } from "@/shared/contracts/roomMap";
import { resolveRoomStructures } from "@/shared/contracts/roomStructureResolver";

import { anchorWallItem, type WallAnchor } from "../../model/roomStructures";

/** In plan pixels, as the walls' own line: the plan scales them with the zoom. */
const WALL_STROKE = 1.5;
const GLASS_GAP_M = 0.07;
const LIGHT_MARK_M = 0.14;
const INK = "var(--lm-ink-dim)";

interface Point {
  x: number;
  y: number;
}

/** The structures as a plan draws them: a window as glass across the wall, a door as its gap,
 *  leaf and swing, a niche dashed behind the wall, a column solid, a beam dashed overhead. */
export function StructurePlan({ config, pxPerMeter }: { config: Pick<RoomMapConfig, "structures" | "dimensions" | "footprint">; pxPerMeter: number }) {
  const structures = useMemo(() => resolveRoomStructures(config), [config]);
  if (structures.length === 0) return null;
  const px = (m: number) => m * pxPerMeter;
  return (
    <svg
      className="absolute pointer-events-none"
      // Over the walls (12), so a door's gap is cut out of the line; under strips and lights (20).
      style={{ zIndex: 13, left: 0, top: 0, overflow: "visible" }}
      width={1}
      height={1}
      aria-hidden="true"
      data-testid="room-structures"
    >
      {structures.map((s) => (
        <g key={s.id} data-structure={s.kind}>
          {shapeOf(s, config, px)}
        </g>
      ))}
    </svg>
  );
}

function shapeOf(s: RoomStructure, config: Pick<RoomMapConfig, "dimensions" | "footprint">, px: (m: number) => number) {
  switch (s.kind) {
    case STRUCTURE_KINDS.COLUMN: {
      const turn = `rotate(${s.rotation ?? 0} ${px(s.x)} ${px(s.y)})`;
      return s.shape === "round" ? (
        <ellipse cx={px(s.x)} cy={px(s.y)} rx={px(s.width / 2)} ry={px(s.depth / 2)} fill={INK} opacity={0.55} stroke={INK} strokeWidth={WALL_STROKE} />
      ) : (
        <rect
          x={px(s.x - s.width / 2)}
          y={px(s.y - s.depth / 2)}
          width={px(s.width)}
          height={px(s.depth)}
          transform={turn}
          fill={INK}
          opacity={0.55}
          stroke={INK}
          strokeWidth={WALL_STROKE}
        />
      );
    }
    case STRUCTURE_KINDS.BEAM: {
      const length = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      const angle = (Math.atan2(s.y2 - s.y1, s.x2 - s.x1) * 180) / Math.PI;
      const cx = (s.x1 + s.x2) / 2;
      const cy = (s.y1 + s.y2) / 2;
      // Dashed, as a plan draws what is above the floor.
      return (
        <rect
          x={px(cx - length / 2)}
          y={px(cy - s.width / 2)}
          width={px(length)}
          height={px(s.width)}
          transform={`rotate(${angle} ${px(cx)} ${px(cy)})`}
          fill="none"
          stroke={INK}
          strokeWidth={1}
          strokeDasharray="6 4"
        />
      );
    }
    case STRUCTURE_KINDS.LIGHT: {
      // A ceiling plan's light: a ring with a cross, dashed as what is overhead is.
      const r = px(LIGHT_MARK_M);
      const cx = px(s.x);
      const cy = px(s.y);
      return (
        <>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={INK} strokeWidth={1} strokeDasharray="3 2" />
          <path d={`M${cx - r * 0.7} ${cy - r * 0.7} L${cx + r * 0.7} ${cy + r * 0.7} M${cx + r * 0.7} ${cy - r * 0.7} L${cx - r * 0.7} ${cy + r * 0.7}`} stroke={INK} strokeWidth={1} />
        </>
      );
    }
    default: {
      const anchor = anchorWallItem(s, config);
      if (!anchor) return null;
      const ends = wallEnds(anchor);
      const across = (m: number): Point => (anchor.alongX ? { x: 0, y: m } : { x: m, y: 0 });
      const at = (p: Point, d: Point, scale: number): Point => ({ x: p.x + d.x * scale, y: p.y + d.y * scale });
      const outwardUnit = across(-anchor.inward);
      if (s.kind === STRUCTURE_KINDS.WINDOW) {
        // Two lines of glass either side of the wall's line, in the gap they leave in it.
        const half = GLASS_GAP_M / 2;
        return (
          <>
            <Line a={ends[0]} b={ends[1]} px={px} stroke="var(--lm-bg)" width={WALL_STROKE * 2.5} />
            <Line a={at(ends[0], outwardUnit, half)} b={at(ends[1], outwardUnit, half)} px={px} stroke={INK} width={1} />
            <Line a={at(ends[0], outwardUnit, -half)} b={at(ends[1], outwardUnit, -half)} px={px} stroke={INK} width={1} />
          </>
        );
      }
      if (s.kind === STRUCTURE_KINDS.NICHE) {
        const back = [at(ends[0], outwardUnit, s.depth), at(ends[1], outwardUnit, s.depth)];
        return (
          <path
            d={`M${px(ends[0].x)} ${px(ends[0].y)} L${px(back[0]!.x)} ${px(back[0]!.y)} L${px(back[1]!.x)} ${px(back[1]!.y)} L${px(ends[1].x)} ${px(ends[1].y)}`}
            fill="none"
            stroke={INK}
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        );
      }
      // A door: its gap, the leaf open square to the wall, and the arc it swings through.
      const outward = { x: outwardUnit.x, y: outwardUnit.y };
      const left = { x: outward.y, y: -outward.x };
      const sign = s.hinge === "left" ? 1 : -1;
      const middle = { x: (ends[0].x + ends[1].x) / 2, y: (ends[0].y + ends[1].y) / 2 };
      const hinge = at(middle, left, (sign * anchor.width) / 2);
      const jamb = at(middle, left, (-sign * anchor.width) / 2);
      const open = s.swing === "in" ? { x: -outward.x, y: -outward.y } : outward;
      const leafEnd = at(hinge, open, anchor.width);
      const closed = { x: jamb.x - hinge.x, y: jamb.y - hinge.y };
      const sweep = closed.x * open.y - closed.y * open.x > 0 ? 1 : 0;
      const r = px(anchor.width);
      return (
        <>
          <Line a={ends[0]} b={ends[1]} px={px} stroke="var(--lm-bg)" width={WALL_STROKE * 2.5} />
          <Line a={hinge} b={leafEnd} px={px} stroke={INK} width={WALL_STROKE} />
          <path d={`M${px(jamb.x)} ${px(jamb.y)} A${r} ${r} 0 0 ${sweep} ${px(leafEnd.x)} ${px(leafEnd.y)}`} fill="none" stroke={INK} strokeWidth={1} strokeDasharray="3 3" />
        </>
      );
    }
  }
}

function wallEnds(anchor: WallAnchor): [Point, Point] {
  const lo = anchor.centre - anchor.width / 2;
  const hi = anchor.centre + anchor.width / 2;
  return anchor.alongX
    ? [
        { x: lo, y: anchor.at },
        { x: hi, y: anchor.at },
      ]
    : [
        { x: anchor.at, y: lo },
        { x: anchor.at, y: hi },
      ];
}

function Line({ a, b, px, stroke, width }: { a: Point; b: Point; px: (m: number) => number; stroke: string; width: number }) {
  return <line x1={px(a.x)} y1={px(a.y)} x2={px(b.x)} y2={px(b.y)} stroke={stroke} strokeWidth={width} />;
}
