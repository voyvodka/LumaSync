import { useTranslation } from "react-i18next";

import type { RoomDimensions } from "@/shared/contracts/roomMap";
import { Segmented } from "@/shared/ui/Segmented/Segmented";

import {
  buildFootprint,
  defaultFootprintShape,
  FOOTPRINT_CORNERS,
  FOOTPRINT_KINDS,
  FOOTPRINT_SIDES,
  type FootprintCorner,
  type FootprintKind,
  type FootprintShape,
  type FootprintSide,
} from "../../model/roomFootprint";
import { DecimalField } from "../DecimalField";
import styles from "./RoomShapeField.module.css";

// Spelled out so the key check sees every one.
const KIND_KEY = {
  rect: "roomMap:shape.kind.rect",
  L: "roomMap:shape.kind.L",
  U: "roomMap:shape.kind.U",
  T: "roomMap:shape.kind.T",
} as const satisfies Record<FootprintKind, string>;
const CORNER_KEY = {
  topLeft: "roomMap:shape.corner.topLeft",
  topRight: "roomMap:shape.corner.topRight",
  bottomRight: "roomMap:shape.corner.bottomRight",
  bottomLeft: "roomMap:shape.corner.bottomLeft",
} as const satisfies Record<FootprintCorner, string>;
const SIDE_KEY = {
  top: "roomMap:shape.side.top",
  right: "roomMap:shape.side.right",
  bottom: "roomMap:shape.side.bottom",
  left: "roomMap:shape.side.left",
} as const satisfies Record<FootprintSide, string>;

const GLYPH = { widthMeters: 16, depthMeters: 12, heightMeters: 1 };

/** A shape drawn as the room would be: the outline it builds, in a 16 × 12 box. */
function ShapeGlyph({ shape }: { shape: FootprintShape }) {
  const corners = buildFootprint(shape, GLYPH) ?? [
    { x: 0, y: 0 },
    { x: 16, y: 0 },
    { x: 16, y: 12 },
    { x: 0, y: 12 },
  ];
  return (
    <svg width="20" height="16" viewBox="-2 -2 20 16" aria-hidden="true" className={styles.glyph}>
      <polygon points={corners.map((c) => `${c.x},${c.y}`).join(" ")} />
    </svg>
  );
}

/** The glyph's own shape at its default size, turned to `corner` or `side`. */
function glyphFor(kind: FootprintKind, place?: FootprintCorner | FootprintSide): FootprintShape {
  const base = defaultFootprintShape(kind, GLYPH);
  if (base.kind === "L" && place) return { ...base, corner: place as FootprintCorner };
  if ((base.kind === "U" || base.kind === "T") && place) {
    const along = place === "top" || place === "bottom" ? 16 : 12;
    return { ...base, side: place as FootprintSide, width: along / 3, offset: along / 3 };
  }
  return base;
}

/**
 * The room's shape: a rectangle, an L, a U or a T, where its cut is, and how big. A shape stored
 * by something this editor does not make shows no kind chosen until one is picked.
 */
export function RoomShapeField({
  shape,
  dimensions,
  onChange,
}: {
  shape: FootprintShape;
  dimensions: RoomDimensions;
  onChange: (shape: FootprintShape) => void;
}) {
  const { t } = useTranslation();
  const kind = shape.kind === "custom" ? null : shape.kind;

  return (
    <div className={styles.field}>
      <div className={styles.row}>
        <span className={styles.label}>
          {shape.kind === "custom" ? t("roomMap:shape.custom") : t("roomMap:shape.label")}
        </span>
        <Segmented
          className={styles.group}
          ariaLabel={t("roomMap:shape.label")}
          value={kind}
          options={FOOTPRINT_KINDS.map((k) => ({
            value: k,
            label: <ShapeGlyph shape={glyphFor(k)} />,
            ariaLabel: t(KIND_KEY[k]),
            title: t(KIND_KEY[k]),
            className: styles.option,
            testId: `room-shape-${k}`,
          }))}
          onChange={(k) => onChange(defaultFootprintShape(k, dimensions))}
        />
      </div>

      {shape.kind === "L" && (
        <>
          <div className={styles.row}>
            <span className={styles.label}>{t("roomMap:shape.cornerLabel")}</span>
            <Segmented
              className={styles.group}
              ariaLabel={t("roomMap:shape.cornerLabel")}
              value={shape.corner}
              options={FOOTPRINT_CORNERS.map((corner) => ({
                value: corner,
                label: <ShapeGlyph shape={glyphFor("L", corner)} />,
                ariaLabel: t(CORNER_KEY[corner]),
                title: t(CORNER_KEY[corner]),
                className: styles.option,
              }))}
              onChange={(corner) => onChange({ ...shape, corner })}
            />
          </div>
          <div className={styles.sizes}>
            <DecimalField
              label={t("roomMap:shape.cutWidth")}
              prefix="W"
              value={shape.width}
              step={0.1}
              unit="m"
              testId="room-shape-width"
              onCommit={(width) => onChange({ ...shape, width })}
            />
            <DecimalField
              label={t("roomMap:shape.cutDepth")}
              prefix="D"
              value={shape.depth}
              step={0.1}
              unit="m"
              testId="room-shape-depth"
              onCommit={(depth) => onChange({ ...shape, depth })}
            />
          </div>
        </>
      )}

      {(shape.kind === "U" || shape.kind === "T") && (
        <>
          <div className={styles.row}>
            <span className={styles.label}>{t("roomMap:shape.sideLabel")}</span>
            <Segmented
              className={styles.group}
              ariaLabel={t("roomMap:shape.sideLabel")}
              value={shape.side}
              options={FOOTPRINT_SIDES.map((side) => ({
                value: side,
                label: <ShapeGlyph shape={glyphFor(shape.kind as FootprintKind, side)} />,
                ariaLabel: t(SIDE_KEY[side]),
                title: t(SIDE_KEY[side]),
                className: styles.option,
              }))}
              onChange={(side) => {
                // A turn to a wall of another length keeps the cut's place in proportion.
                const from = shape.side === "top" || shape.side === "bottom" ? dimensions.widthMeters : dimensions.depthMeters;
                const to = side === "top" || side === "bottom" ? dimensions.widthMeters : dimensions.depthMeters;
                onChange({ ...shape, side, width: (shape.width * to) / from, offset: (shape.offset * to) / from });
              }}
            />
          </div>
          <div className={styles.sizes}>
            <DecimalField
              label={shape.kind === "U" ? t("roomMap:shape.notchWidth") : t("roomMap:shape.stemWidth")}
              prefix="W"
              value={shape.width}
              step={0.1}
              unit="m"
              testId="room-shape-width"
              onCommit={(width) => onChange({ ...shape, width })}
            />
            <DecimalField
              label={shape.kind === "U" ? t("roomMap:shape.notchDepth") : t("roomMap:shape.stemDepth")}
              prefix="D"
              value={shape.depth}
              step={0.1}
              unit="m"
              testId="room-shape-depth"
              onCommit={(depth) => onChange({ ...shape, depth })}
            />
            <DecimalField
              label={t("roomMap:shape.offset")}
              prefix="↦"
              value={shape.offset}
              step={0.1}
              unit="m"
              testId="room-shape-offset"
              onCommit={(offset) => onChange({ ...shape, offset })}
            />
          </div>
        </>
      )}
    </div>
  );
}
