import { useTranslation } from "react-i18next";

import type { ImageLayer } from "@/shared/contracts/roomMap";
import { IconButton } from "@/shared/ui/IconButton/IconButton";
import { IconImage, IconLock, IconOpacity, IconRefresh, IconUnlock } from "@/shared/ui/icons";

import { TYPE_DOT_COLOR } from "../../model/zoneColor";
import { ROOM_MAP_PX_PER_METER } from "../../state/useRoomMapViewport";
import { DecimalField } from "../DecimalField";
import { DockSlider } from "../dock/DockSlider";
import { Actions, FieldRow, InspectorRows, Mark, NameField } from "../dock/InspectorParts";
import { GlyphDepth, GlyphWidth } from "./fieldGlyphs";
import styles from "./ImageLayerInspector.module.css";

const MIN_SCALE = 0.05;
const MAX_SCALE = 20;

export function ImageLayerInspector({
  layer,
  onUpdate,
  onToggleLock,
  onRename,
  onDelete,
  onClose,
}: {
  layer: ImageLayer;
  onUpdate: (patch: Partial<ImageLayer>) => void;
  onToggleLock: () => void;
  onRename: (label: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const locked = !!layer.locked;
  const opacity = layer.opacity ?? 100;
  // The layer is placed in canvas pixels at zoom 1; the inspector speaks the map's metres.
  const metres = (px: number) => px / ROOM_MAP_PX_PER_METER;
  const pixels = (m: number) => m * ROOM_MAP_PX_PER_METER;
  const sx = layer.scaleX ?? layer.scale;
  const sy = layer.scaleY ?? layer.scale;
  const aspectLocked = layer.aspectLocked !== false;

  return (
    <InspectorRows
      first={
        <>
          <Mark>
            <span style={{ color: TYPE_DOT_COLOR.image, display: "grid" }}>
              <IconImage />
            </span>
          </Mark>
          <NameField
            first
            value={layer.label}
            fallback={layer.label}
            label={t("roomMap:inspector.furnitureNameLabel")}
            disabled={locked}
            onCommit={onRename}
          />
          <Actions locked={locked} onToggleLock={onToggleLock} onDelete={onDelete} onClose={onClose} />
        </>
      }
      second={
        <>
          <FieldRow>
            <DecimalField
              label={t("roomMap:inspector.xLabel")}
              prefix="X"
              value={metres(layer.offsetX)}
              unit="m"
              disabled={locked}
              onCommit={(x) => onUpdate({ offsetX: pixels(x) })}
            />
            <DecimalField
              label={t("roomMap:inspector.yLabel")}
              prefix="Y"
              value={metres(layer.offsetY)}
              unit="m"
              disabled={locked}
              onCommit={(y) => onUpdate({ offsetY: pixels(y) })}
            />
            {aspectLocked ? (
              <DecimalField
                label={t("roomMap:inspector.imageScaleLabel")}
                prefix="×"
                value={sx}
                min={MIN_SCALE}
                max={MAX_SCALE}
                disabled={locked}
                // Keeps the current proportions, as the canvas handles do.
                onCommit={(next) => onUpdate({ scaleX: next, scaleY: Math.max(MIN_SCALE, next * (sx > 0 ? sy / sx : 1)) })}
              />
            ) : (
              <>
                <DecimalField
                  label={t("roomMap:inspector.imageScaleXLabel")}
                  prefix={<GlyphWidth />}
                  value={sx}
                  min={MIN_SCALE}
                  max={MAX_SCALE}
                  disabled={locked}
                  onCommit={(next) => onUpdate({ scaleX: next, scaleY: sy })}
                />
                <DecimalField
                  label={t("roomMap:inspector.imageScaleYLabel")}
                  prefix={<GlyphDepth />}
                  value={sy}
                  min={MIN_SCALE}
                  max={MAX_SCALE}
                  disabled={locked}
                  onCommit={(next) => onUpdate({ scaleX: sx, scaleY: next })}
                />
              </>
            )}
          </FieldRow>
          <IconButton
            className={styles.action}
            label={aspectLocked ? t("roomMap:inspector.imageAspectLocked") : t("roomMap:inspector.imageAspectUnlocked")}
            aria-pressed={aspectLocked}
            icon={aspectLocked ? <IconLock /> : <IconUnlock />}
            disabled={locked}
            onClick={() => onUpdate({ aspectLocked: !aspectLocked })}
          />
          <IconButton
            className={styles.action}
            label={t("roomMap:inspector.imageAspectReset")}
            icon={<IconRefresh />}
            // Equal proportions at the current width; nothing to do when they already are.
            disabled={locked || sx === sy}
            onClick={() => onUpdate({ scaleX: sx, scaleY: sx })}
          />
          <DockSlider
            label={t("roomMap:inspector.imageOpacityLabel")}
            prefix={<IconOpacity />}
            min={0}
            max={100}
            step={1}
            value={opacity}
            disabled={locked}
            onChange={(next) => onUpdate({ opacity: Math.trunc(next) })}
            readout={`${opacity}%`}
          />
        </>
      }
    />
  );
}
