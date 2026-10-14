import { useState } from "react";
import { useTranslation } from "react-i18next";

import { autoVariant, type FurnitureModel, modelTop, toneCss } from "@/features/room-view/model/furnitureModel";
import {
  FURNITURE_CATALOGUE,
  FURNITURE_TYPES,
  type FurniturePlacement,
  type FurnitureTone,
  type FurnitureType,
  type FurnitureVariant,
  resolveFurnitureTone,
  resolveFurnitureTop,
  resolveFurnitureType,
  resolveFurnitureVariant,
} from "@/shared/contracts/roomMap";
import { InfoTip } from "@/shared/ui/InfoTip/InfoTip";
import { Segmented } from "@/shared/ui/Segmented/Segmented";
import { retypeFurniture } from "../../model/furnitureKinds";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";
import styles from "./FurnitureInspector.module.css";
import { Header, InspectorNumberField, InspectorOptionalNumberField } from "./InspectorPrimitives";

const AUTO = "auto";
const DEFAULT_TONE = "default";
const MAX_TOP_METRES = 3;

export function FurnitureInspector({
  item,
  model,
  autoModel,
  modelChoices,
  onUpdate,
  onToggleLock,
  onRename,
}: {
  item: FurniturePlacement;
  /** What the piece is drawn as now — the automatic reading, or the user's pick. */
  model: FurnitureModel | undefined;
  /** What it would read as with no pick: the name the Auto choice carries. */
  autoModel: FurnitureModel | undefined;
  /** Model, tone and height are drawn only by the 3D room; a build without it does not offer them,
   *  so nothing is stored that nothing shows. */
  modelChoices: boolean;
  onUpdate: (patch: Partial<FurniturePlacement>) => void;
  onToggleLock: () => void;
  onRename: (label: string) => void;
}) {
  const { t } = useTranslation();
  const locked = !!item.locked;
  const type = resolveFurnitureType(item.type);
  const spec = FURNITURE_CATALOGUE[type];
  const variant = resolveFurnitureVariant(item);
  const tone = resolveFurnitureTone(item);
  const typeName = t(`roomMap:furniture.type.${type}`);
  const [labelDraft, setLabelDraft] = useState(item.label ?? typeName);
  const [labelDirty, setLabelDirty] = useState(false);

  const commitLabel = () => {
    setLabelDirty(false);
    const trimmed = labelDraft.trim();
    if (!trimmed) {
      setLabelDraft(item.label ?? typeName);
      return;
    }
    if (trimmed !== item.label) onRename(trimmed);
  };

  // Sync external rename while not editing.
  if (!labelDirty) {
    const external = item.label ?? typeName;
    if (external !== labelDraft) setLabelDraft(external);
  }

  const reading = autoModel ? autoVariant(autoModel) : null;
  const autoName = reading ? t(`roomMap:furniture.variant.${reading}`) : null;
  const modelOptions = [
    {
      value: AUTO,
      label: t("roomMap:inspector.modelAuto", { model: autoName ?? typeName }),
      ariaLabel: autoName ? t("roomMap:inspector.modelAutoAria", { model: autoName }) : undefined,
      className: styles.chip,
    },
    ...spec.variants.map((v) => ({
      value: v,
      label: t(`roomMap:furniture.variant.${v}`),
      className: styles.chip,
    })),
  ];
  const toneOptions = [
    {
      value: DEFAULT_TONE,
      label: <span className={`${styles.disc} ${styles.discDefault}`} aria-hidden="true" />,
      ariaLabel: t("roomMap:inspector.toneDefault"),
      title: t("roomMap:inspector.toneDefault"),
      className: styles.swatch,
    },
    ...spec.tones.map((tn) => ({
      value: tn,
      label: <span className={styles.disc} style={{ background: toneCss(tn) }} aria-hidden="true" />,
      ariaLabel: t(`roomMap:furniture.tone.${tn}`),
      title: t(`roomMap:furniture.tone.${tn}`),
      className: styles.swatch,
    })),
  ];

  return (
    <>
      <Header typeLabel={t("roomMap:inspector.typeFurniture")} name={item.label ?? typeName} dotColor={TYPE_DOT_COLOR.furniture} />
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
              setLabelDraft(item.label ?? typeName);
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
          value={type}
          disabled={locked}
          onChange={(e) => onUpdate(retypeFurniture(item, e.target.value as FurnitureType))}
        >
          {Object.values(FURNITURE_TYPES).map((tp) => (
            <option key={tp} value={tp}>
              {t(`roomMap:furniture.type.${tp}`)}
            </option>
          ))}
        </select>
      </div>

      {modelChoices && spec.variants.length > 0 && (
        <div className={styles.group}>
          <span className={styles.labelRow}>
            <span className={`lm-room-dock-field-label ${styles.label}`}>{t("roomMap:inspector.modelLabel")}</span>
            <InfoTip label={t("roomMap:inspector.modelLabel")}>{t("roomMap:inspector.modelInfo")}</InfoTip>
          </span>
          <Segmented
            className={styles.row}
            ariaLabel={t("roomMap:inspector.modelLabel")}
            value={variant ?? AUTO}
            disabled={locked}
            options={modelOptions}
            onChange={(next) => onUpdate({ variant: next === AUTO ? undefined : (next as FurnitureVariant) })}
          />
        </div>
      )}

      {modelChoices && (
      <div className={styles.group}>
        <span className={`lm-room-dock-field-label ${styles.label}`}>{t("roomMap:inspector.toneLabel")}</span>
        <Segmented
          className={styles.row}
          ariaLabel={t("roomMap:inspector.toneLabel")}
          value={tone ?? DEFAULT_TONE}
          disabled={locked}
          options={toneOptions}
          onChange={(next) => onUpdate({ tone: next === DEFAULT_TONE ? undefined : (next as FurnitureTone) })}
        />
      </div>
      )}

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
        id={`furn-d-${item.id}`}
        label={t("roomMap:inspector.depthLabel")}
        value={item.height}
        step={0.05}
        min={0.1}
        unit="m"
        disabled={locked}
        onCommit={(next) => onUpdate({ height: next })}
      />
      {modelChoices && type !== "rug" && model && (
        <>
          <InspectorOptionalNumberField
            id={`furn-top-${item.id}`}
            label={t("roomMap:inspector.heightLabel")}
            value={resolveFurnitureTop(item)}
            placeholder={modelTop(model).toFixed(2)}
            min={0.1}
            max={MAX_TOP_METRES}
            unit="m"
            disabled={locked}
            describedBy={`furn-top-hint-${item.id}`}
            onCommit={(next) => onUpdate({ topMeters: next })}
          />
          <p id={`furn-top-hint-${item.id}`} className="lm-room-dock-field-hint">
            {t("roomMap:inspector.topHint", { metres: modelTop(model).toFixed(2) })}
          </p>
        </>
      )}
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

      <button type="button" className="lm-room-dock-inspect-action" onClick={onToggleLock} aria-pressed={locked}>
        {locked ? t("roomMap:objectPanel.unlock") : t("roomMap:objectPanel.lock")}
      </button>
    </>
  );
}
