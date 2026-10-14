import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/shared/ui/IconButton/IconButton";
import { IconLock, IconRefresh, IconUnlock } from "@/shared/ui/icons";
import { RangeRow } from "@/shared/ui/RangeRow/RangeRow";

import type { ImageLayer } from "@/shared/contracts/roomMap";
import { Header } from "./InspectorPrimitives";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";
import { ROOM_MAP_PX_PER_METER } from "../../state/useRoomMapViewport";
import { DecimalField, FieldPair } from "../DecimalField";
import { GlyphDepth, GlyphWidth } from "./fieldGlyphs";
import styles from "./ImageLayerInspector.module.css";

const MIN_SCALE = 0.05;
const MAX_SCALE = 20;

export function ImageLayerInspector({
  layer,
  onUpdate,
  onToggleLock,
  onRename,
}: {
  layer: ImageLayer;
  onUpdate: (patch: Partial<ImageLayer>) => void;
  onToggleLock: () => void;
  onRename: (label: string) => void;
}) {
  const { t } = useTranslation();
  const locked = !!layer.locked;
  const [labelDraft, setLabelDraft] = useState(layer.label);
  const [labelDirty, setLabelDirty] = useState(false);

  if (!labelDirty && layer.label !== labelDraft) setLabelDraft(layer.label);

  const commitLabel = () => {
    setLabelDirty(false);
    const trimmed = labelDraft.trim();
    if (!trimmed) {
      setLabelDraft(layer.label);
      return;
    }
    if (trimmed !== layer.label) onRename(trimmed);
  };

  const opacity = layer.opacity ?? 100;
  // The layer is placed in canvas pixels at zoom 1; the inspector speaks the map's metres.
  const metres = (px: number) => px / ROOM_MAP_PX_PER_METER;
  const pixels = (m: number) => m * ROOM_MAP_PX_PER_METER;
  const sx = layer.scaleX ?? layer.scale;
  const sy = layer.scaleY ?? layer.scale;
  const aspectLocked = layer.aspectLocked !== false;

  return (
    <>
      <Header
        typeLabel={t("roomMap:inspector.typeImage")}
        name={layer.label}
        dotColor={TYPE_DOT_COLOR.image}
      />
      <div className="lm-room-dock-field">
        <label className="lm-room-dock-field-label" htmlFor={`img-name-${layer.id}`}>
          {t("roomMap:inspector.furnitureNameLabel")}
        </label>
        <input
          id={`img-name-${layer.id}`}
          type="text"
          className="lm-room-dock-input"
          value={labelDraft}
          disabled={locked}
          onChange={(e) => {
            setLabelDirty(true);
            setLabelDraft(e.target.value);
          }}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitLabel();
            } else if (e.key === "Escape") {
              setLabelDraft(layer.label);
              setLabelDirty(false);
            }
          }}
        />
      </div>
      <FieldPair>
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
      </FieldPair>
      <div className={styles.scale}>
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
          <FieldPair>
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
          </FieldPair>
        )}
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
      </div>
      <RangeRow
        variant="dock"
        label={t("roomMap:inspector.imageOpacityLabel")}
        min={0}
        max={100}
        step={1}
        value={opacity}
        disabled={locked}
        onChange={(next) => onUpdate({ opacity: Math.trunc(next) })}
        valueLabel={`${opacity}%`}
      />
      <button
        type="button"
        className="lm-room-dock-inspect-action"
        onClick={onToggleLock}
        aria-pressed={locked}
      >
        {locked ? t("roomMap:objectPanel.unlock") : t("roomMap:objectPanel.lock")}
      </button>
      <p className="lm-room-dock-field-hint">{t("roomMap:inspector.imageHint")}</p>
    </>
  );
}
