import { type RefObject, useId } from "react";
import { useTranslation } from "react-i18next";

import { floorSwatchCss, wallSwatchCss } from "@/features/room-view/model/surfaceColours";
import {
  DEFAULT_ROOM_DIMENSIONS,
  FLOOR_FINISHES,
  type FloorFinish,
  type RoomDimensions,
  type RoomSurfaces,
  resolveRoomSurfaces,
  WALL_COLORS,
  type WallColor,
} from "@/shared/contracts/roomMap";
import { Segmented } from "@/shared/ui/Segmented/Segmented";
import { Popover } from "@/shared/ui/Popover/Popover";
import { Toggle } from "@/shared/ui/Toggle/Toggle";

import { DecimalField, FieldHint } from "../DecimalField";
import { GlyphDepth, GlyphHeight, GlyphWidth } from "../objects/fieldGlyphs";
import type { FootprintShape } from "../../model/roomFootprint";
import { ROOM_SIDE_MAX_M, ROOM_SIDE_MIN_M } from "../../model/roomResize";
import { DockSlider } from "./DockSlider";
import { RoomShapeField } from "./RoomShapeField";
import styles from "./RoomPanel.module.css";

/** A low basement to a double-height room. */
export const ROOM_HEIGHT_MIN_M = 1.5;
export const ROOM_HEIGHT_MAX_M = 8;

export interface RoomSettings {
  dimensions: RoomDimensions;
  onDimensionsChange: (dimensions: RoomDimensions) => void;
  /** The room's outline in the editor's terms. */
  shape: FootprintShape;
  onShapeChange: (shape: FootprintShape) => void;
  /** The smallest width and depth the outline still fits. */
  minimumSize: { widthMeters: number; depthMeters: number };
  showGrid: boolean;
  onShowGridChange: (show: boolean) => void;
  gridStrokeWidth: number;
  onGridStrokeWidthChange: (width: number) => void;
  showHueZones: boolean;
  onShowHueZonesChange: (show: boolean) => void;
  /** The grid and the zones' outlines are the plan's; the 3D stage hides their switches. */
  onPlan?: boolean;
  /** What the room is finished in; offered only where the 3D room draws it. */
  surfaces?: { value: RoomSurfaces | undefined; onChange: (patch: RoomSurfaces) => void };
}

/** The room itself: its size, what the plan draws over it, and starting over. */
export function RoomPanel({
  open,
  onClose,
  anchorRef,
  id,
  settings,
  onReset,
  onTemplates,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  id: string;
  settings: RoomSettings;
  /** Asks first: the panel closes and the question takes its place. */
  onReset: () => void;
  /** Opens the template picker over the room; a pick is one undo step. */
  onTemplates?: () => void;
}) {
  const { t } = useTranslation();
  const hintId = useId();
  const { dimensions, onDimensionsChange, minimumSize } = settings;

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} side="above" width={288} id={id} label={t("roomMap:dock.room")} role="dialog">
      <div className={styles.panel}>
        <div className={styles.size}>
          <DecimalField
            label={t("roomMap:settings.roomWidth")}
            prefix={<GlyphWidth />}
            value={dimensions.widthMeters}
            min={Math.max(ROOM_SIDE_MIN_M, minimumSize.widthMeters)}
            max={ROOM_SIDE_MAX_M}
            step={0.5}
            unit="m"
            testId="room-width"
            onCommit={(widthMeters) => onDimensionsChange({ ...dimensions, widthMeters })}
          />
          <DecimalField
            label={t("roomMap:settings.roomDepth")}
            prefix={<GlyphDepth />}
            value={dimensions.depthMeters}
            min={Math.max(ROOM_SIDE_MIN_M, minimumSize.depthMeters)}
            max={ROOM_SIDE_MAX_M}
            step={0.5}
            unit="m"
            testId="room-depth"
            onCommit={(depthMeters) => onDimensionsChange({ ...dimensions, depthMeters })}
          />
          <DecimalField
            label={t("roomMap:settings.roomHeight")}
            prefix={<GlyphHeight />}
            value={dimensions.heightMeters ?? DEFAULT_ROOM_DIMENSIONS.heightMeters}
            min={ROOM_HEIGHT_MIN_M}
            max={ROOM_HEIGHT_MAX_M}
            step={0.1}
            unit="m"
            describedBy={`${hintId}-height`}
            testId="room-height"
            onCommit={(heightMeters) => onDimensionsChange({ ...dimensions, heightMeters })}
          />
        </div>
        <FieldHint id={`${hintId}-height`}>{t("roomMap:settings.roomHeightHint")}</FieldHint>

        <RoomShapeField shape={settings.shape} dimensions={dimensions} onChange={settings.onShapeChange} />
        {/* The plan's walls are handles with no mark of their own until hovered; this is where that is said. */}
        <FieldHint>{settings.shape.kind === "rect" ? t("roomMap:shape.planHintRect") : t("roomMap:shape.planHintShaped")}</FieldHint>

        {settings.surfaces ? <SurfaceFields {...settings.surfaces} /> : null}

        {settings.onPlan !== false && (
          <>
            <label className={styles.toggle}>
              <span>{t("roomMap:settings.showGrid")}</span>
              <Toggle checked={settings.showGrid} onChange={settings.onShowGridChange} label={t("roomMap:settings.showGrid")} />
            </label>
            <div className={styles.slider}>
              <span className={styles.sliderLabel} aria-hidden="true">
                {t("roomMap:settings.gridStrokeWidth")}
              </span>
              <DockSlider
                label={t("roomMap:settings.gridStrokeWidth")}
                min={0.5}
                max={3}
                step={0.1}
                value={settings.gridStrokeWidth}
                disabled={!settings.showGrid}
                onChange={settings.onGridStrokeWidthChange}
                readout={`${settings.gridStrokeWidth.toFixed(1)} px`}
              />
            </div>

            <label className={styles.toggle}>
              <span>{t("roomMap:settings.showHueZones")}</span>
              <Toggle
                checked={settings.showHueZones}
                onChange={settings.onShowHueZonesChange}
                label={t("roomMap:settings.showHueZones")}
                aria-describedby={`${hintId}-zones`}
              />
            </label>
            <FieldHint id={`${hintId}-zones`}>{t("roomMap:settings.showHueZonesHint")}</FieldHint>
          </>
        )}

        <hr className={styles.rule} />

        {onTemplates && (
          <>
            <button type="button" className={styles.templates} aria-describedby={`${hintId}-templates`} onClick={onTemplates}>
              {t("roomMap:settings.templates")}
            </button>
            <FieldHint id={`${hintId}-templates`}>{t("roomMap:settings.templatesHint")}</FieldHint>
          </>
        )}
        <button type="button" className={styles.reset} aria-describedby={`${hintId}-reset`} onClick={onReset}>
          {t("roomMap:settings.resetMap")}
        </button>
        <FieldHint id={`${hintId}-reset`}>{t("roomMap:settings.resetMapHint")}</FieldHint>
      </div>
    </Popover>
  );
}

const FLOOR_ORDER = Object.values(FLOOR_FINISHES);
const WALL_ORDER = Object.values(WALL_COLORS);

/** The floor and the walls as two rows of discs, each the colour the 3D room turns. */
function SurfaceFields({ value, onChange }: { value: RoomSurfaces | undefined; onChange: (patch: RoomSurfaces) => void }) {
  const { t } = useTranslation();
  const shown = resolveRoomSurfaces({ surfaces: value });
  return (
    <div className={styles.surfaces}>
      <div className={styles.surfaceRow}>
        <span className={styles.surfaceLabel}>{t("roomMap:settings.floor")}</span>
        <Segmented
          className={styles.swatches}
          ariaLabel={t("roomMap:settings.floor")}
          value={shown.floor}
          options={FLOOR_ORDER.map((finish) => ({
            value: finish,
            label: <span className={styles.swatchDisc} style={{ background: floorSwatchCss(finish) }} aria-hidden="true" />,
            ariaLabel: t(`roomMap:surfaces.floor.${finish}`),
            title: t(`roomMap:surfaces.floor.${finish}`),
            className: styles.swatch,
          }))}
          onChange={(floor) => onChange({ floor: floor as FloorFinish })}
        />
      </div>
      <div className={styles.surfaceRow}>
        <span className={styles.surfaceLabel}>{t("roomMap:settings.walls")}</span>
        <Segmented
          className={styles.swatches}
          ariaLabel={t("roomMap:settings.walls")}
          value={shown.walls}
          options={WALL_ORDER.map((paint) => ({
            value: paint,
            label: <span className={styles.swatchDisc} style={{ background: wallSwatchCss(paint) }} aria-hidden="true" />,
            ariaLabel: t(`roomMap:surfaces.walls.${paint}`),
            title: t(`roomMap:surfaces.walls.${paint}`),
            className: styles.swatch,
          }))}
          onChange={(walls) => onChange({ walls: walls as WallColor })}
        />
      </div>
    </div>
  );
}
