import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ImageLayer } from "@/shared/contracts/roomMap";
import { Header } from "./InspectorPrimitives";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";

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
      <div className="lm-room-dock-field">
        <label className="lm-room-dock-field-label" htmlFor={`img-opacity-${layer.id}`}>
          {t("roomMap:inspector.imageOpacityLabel")}
        </label>
        <input
          id={`img-opacity-${layer.id}`}
          type="range"
          min={0}
          max={100}
          step={1}
          value={opacity}
          disabled={locked}
          onChange={(e) => onUpdate({ opacity: parseInt(e.target.value, 10) })}
          className="lm-room-dock-slider"
          aria-label={t("roomMap:inspector.imageOpacityLabel")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={opacity}
        />
        <span className="lm-room-dock-field-value">{opacity}%</span>
      </div>
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
