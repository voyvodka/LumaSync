import { type RefObject, useId } from "react";
import { useTranslation } from "react-i18next";

import { DEFAULT_ROOM_DIMENSIONS, type RoomDimensions } from "@/shared/contracts/roomMap";
import { Popover } from "@/shared/ui/Popover/Popover";
import { Toggle } from "@/shared/ui/Toggle/Toggle";

import { DecimalField, FieldHint } from "../DecimalField";
import { GlyphDepth, GlyphHeight, GlyphWidth } from "../objects/fieldGlyphs";
import { DockSlider } from "./DockSlider";
import styles from "./RoomPanel.module.css";

/** A low basement to a double-height room. */
export const ROOM_HEIGHT_MIN_M = 1.5;
export const ROOM_HEIGHT_MAX_M = 8;
const ROOM_SIDE_MIN_M = 1;
const ROOM_SIDE_MAX_M = 30;

export interface RoomSettings {
  dimensions: RoomDimensions;
  onDimensionsChange: (dimensions: RoomDimensions) => void;
  showGrid: boolean;
  onShowGridChange: (show: boolean) => void;
  gridStrokeWidth: number;
  onGridStrokeWidthChange: (width: number) => void;
  showHueZones: boolean;
  onShowHueZonesChange: (show: boolean) => void;
}

/** The room itself: its size, what the plan draws over it, and starting over. */
export function RoomPanel({
  open,
  onClose,
  anchorRef,
  id,
  settings,
  onReset,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  id: string;
  settings: RoomSettings;
  /** Asks first: the panel closes and the question takes its place. */
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const hintId = useId();
  const { dimensions, onDimensionsChange } = settings;

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} side="above" width={288} id={id} label={t("roomMap:dock.room")} role="dialog">
      <div className={styles.panel}>
        <div className={styles.size}>
          <DecimalField
            label={t("roomMap:settings.roomWidth")}
            prefix={<GlyphWidth />}
            value={dimensions.widthMeters}
            min={ROOM_SIDE_MIN_M}
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
            min={ROOM_SIDE_MIN_M}
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

        <hr className={styles.rule} />

        <button type="button" className={styles.reset} aria-describedby={`${hintId}-reset`} onClick={onReset}>
          {t("roomMap:settings.resetMap")}
        </button>
        <FieldHint id={`${hintId}-reset`}>{t("roomMap:settings.resetMapHint")}</FieldHint>
      </div>
    </Popover>
  );
}
