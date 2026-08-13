import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { FurniturePlacement } from "@/shared/contracts/roomMap";
import { Header, InspectorNumberField } from "./InspectorPrimitives";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";

const FURNITURE_TYPES: FurniturePlacement["type"][] = ["sofa", "table", "chair", "other"];

export function FurnitureInspector({
  item,
  onUpdate,
  onToggleLock,
  onRename,
}: {
  item: FurniturePlacement;
  onUpdate: (patch: Partial<FurniturePlacement>) => void;
  onToggleLock: () => void;
  onRename: (label: string) => void;
}) {
  const { t } = useTranslation();
  const locked = !!item.locked;
  const [labelDraft, setLabelDraft] = useState(item.label ?? t(`roomMap:furniture.type.${item.type}`));
  const [labelDirty, setLabelDirty] = useState(false);

  const commitLabel = () => {
    setLabelDirty(false);
    const trimmed = labelDraft.trim();
    if (!trimmed) {
      setLabelDraft(item.label ?? t(`roomMap:furniture.type.${item.type}`));
      return;
    }
    if (trimmed !== item.label) onRename(trimmed);
  };

  // Sync external rename while not editing.
  if (!labelDirty) {
    const external = item.label ?? t(`roomMap:furniture.type.${item.type}`);
    if (external !== labelDraft) setLabelDraft(external);
  }

  return (
    <>
      <Header
        typeLabel={t("roomMap:inspector.typeFurniture")}
        name={item.label ?? t(`roomMap:furniture.type.${item.type}`)}
        dotColor={TYPE_DOT_COLOR.furniture}
      />
      <div className="lm-room-dock-field">
        <label className="lm-room-dock-field-label" htmlFor={`furn-name-${item.id}`}>
          {t("roomMap:inspector.furnitureNameLabel")}
        </label>
        <input
          id={`furn-name-${item.id}`}
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
              setLabelDraft(item.label ?? t(`roomMap:furniture.type.${item.type}`));
              setLabelDirty(false);
            }
          }}
        />
      </div>

      <div className="lm-room-dock-field">
        <label className="lm-room-dock-field-label" htmlFor={`furn-type-${item.id}`}>
          {t("roomMap:inspector.furnitureTypeLabel")}
        </label>
        <select
          id={`furn-type-${item.id}`}
          className="lm-room-dock-select"
          value={item.type}
          disabled={locked}
          onChange={(e) => onUpdate({ type: e.target.value as FurniturePlacement["type"] })}
        >
          {FURNITURE_TYPES.map((tp) => (
            <option key={tp} value={tp}>
              {t(`roomMap:furniture.type.${tp}`)}
            </option>
          ))}
        </select>
      </div>

      <InspectorNumberField
        id={`furn-w-${item.id}`}
        label={t("roomMap:inspector.widthLabel")}
        value={item.width}
        step={0.05}
        min={0.1}
        unit="m"
        disabled={locked}
        onCommit={(next) => onUpdate({ width: next })}
      />
      <InspectorNumberField
        id={`furn-h-${item.id}`}
        label={t("roomMap:inspector.heightLabel")}
        value={item.height}
        step={0.05}
        min={0.1}
        unit="m"
        disabled={locked}
        onCommit={(next) => onUpdate({ height: next })}
      />
      <InspectorNumberField
        id={`furn-r-${item.id}`}
        label={t("roomMap:inspector.furnitureRotationLabel")}
        value={item.rotation ?? 0}
        step={1}
        min={0}
        max={359}
        unit="°"
        disabled={locked}
        onCommit={(next) => onUpdate({ rotation: ((next % 360) + 360) % 360 })}
      />

      <button
        type="button"
        className="lm-room-dock-inspect-action"
        onClick={onToggleLock}
        aria-pressed={locked}
      >
        {locked ? t("roomMap:objectPanel.unlock") : t("roomMap:objectPanel.lock")}
      </button>
    </>
  );
}
