import { useTranslation } from "react-i18next";

import { autoVariant, furnitureColours, type FurnitureModel, modelTop } from "@/features/room-view/model/furnitureModel";
import {
  FURNITURE_CATALOGUE,
  FURNITURE_TYPES,
  type FurniturePlacement,
  type FurnitureType,
  type FurnitureVariant,
  resolveFurnitureTone,
  resolveFurnitureTop,
  resolveFurnitureType,
  resolveFurnitureVariant,
} from "@/shared/contracts/roomMap";
import { InfoTip } from "@/shared/ui/InfoTip/InfoTip";

import { retypeFurniture } from "../../model/furnitureKinds";
import { furnitureTile } from "../../model/paletteTiles";
import { DecimalField } from "../DecimalField";
import { DockPicker } from "../dock/DockPicker";
import { TonePicker } from "../dock/DockSwatches";
import { Actions, FieldRow, FieldTip, InspectorRows, Mark, NameField, Note } from "../dock/InspectorParts";
import { GlyphDepth, GlyphHeight, GlyphRotation, GlyphWidth } from "./fieldGlyphs";
import { FurnitureGlyph } from "./FurnitureGlyph";

const AUTO = "auto";
const MAX_TOP_METRES = 3;
const MIN_SIDE_METRES = 0.1;
const wrapDegrees = (degrees: number) => ((degrees % 360) + 360) % 360;
const TYPES = Object.values(FURNITURE_TYPES);

function TypeMark({ type }: { type: FurnitureType }) {
  const tile = furnitureTile(type);
  return (
    <span style={{ display: "block", width: 22, height: 16 }}>
      <FurnitureGlyph model={tile.model} colours={furnitureColours(tile.piece, tile.model)} width={tile.piece.width} depth={tile.piece.height} fit />
    </span>
  );
}

export function FurnitureInspector({
  item,
  outside = false,
  model,
  autoModel,
  modelChoices,
  onUpdate,
  onRename,
  onToggleLock,
  onDuplicate,
  onDelete,
  onClose,
}: {
  item: FurniturePlacement;
  /** Its middle sits outside the room's outline. */
  outside?: boolean;
  /** What the piece is drawn as now — the automatic reading, or the user's pick. */
  model: FurnitureModel | undefined;
  /** What it would read as with no pick: the name the Auto choice carries. */
  autoModel: FurnitureModel | undefined;
  /** Model, tone and height are drawn only by the 3D room; a build without it does not offer them,
   *  so nothing is stored that nothing shows. */
  modelChoices: boolean;
  onUpdate: (patch: Partial<FurniturePlacement>) => void;
  onRename: (label: string) => void;
  onToggleLock: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const locked = !!item.locked;
  const type = resolveFurnitureType(item.type);
  const spec = FURNITURE_CATALOGUE[type];
  const variant = resolveFurnitureVariant(item);
  const typeName = t(`roomMap:furniture.type.${type}`);
  const reading = autoModel ? autoVariant(autoModel) : null;
  const autoName = reading ? t(`roomMap:furniture.variant.${reading}`) : typeName;
  const drawn = model ?? autoModel ?? furnitureTile(type).model;
  const showHeight = modelChoices && type !== "rug" && model !== undefined;

  return (
    <InspectorRows
      first={
        <>
          <Mark>
            <span style={{ display: "block", width: 24, height: 20 }}>
              <FurnitureGlyph model={drawn} colours={furnitureColours(item, drawn)} width={item.width} depth={item.height} fit />
            </span>
          </Mark>
          <NameField
            first
            value={item.label}
            fallback={typeName}
            label={t("roomMap:inspector.furnitureNameLabel")}
            disabled={locked}
            onCommit={onRename}
          />
          {outside && (
            <Note tone="warning" fit title={t("roomMap:inspector.outsideShapeHint")}>
              {t("roomMap:inspector.outsideShape")}
            </Note>
          )}
          <DockPicker
            label={t("roomMap:inspector.furnitureTypeLabel")}
            value={type}
            width={104}
            buttonMark={false}
            disabled={locked}
            options={TYPES.map((tp) => ({ value: tp, label: t(`roomMap:furniture.type.${tp}`), mark: <TypeMark type={tp} /> }))}
            onChange={(next) => onUpdate(retypeFurniture(item, next))}
          />
          {modelChoices && spec.variants.length > 0 && (
            <>
              <DockPicker
                label={t("roomMap:inspector.modelLabel")}
                value={variant ?? AUTO}
                width={168}
                disabled={locked}
                options={[
                  { value: AUTO, label: t("roomMap:inspector.modelAuto", { model: autoName }) },
                  ...spec.variants.map((v) => ({ value: v, label: t(`roomMap:furniture.variant.${v}`) })),
                ]}
                onChange={(next) => onUpdate({ variant: next === AUTO ? undefined : (next as FurnitureVariant) })}
              />
              <InfoTip label={t("common:hintFor", { label: t("roomMap:inspector.modelLabel") })}>{t("roomMap:inspector.modelInfo")}</InfoTip>
            </>
          )}
          {modelChoices && (
            <TonePicker value={resolveFurnitureTone(item)} tones={spec.tones} disabled={locked} onChange={(tone) => onUpdate({ tone })} />
          )}
          <Actions locked={locked} onToggleLock={onToggleLock} onDuplicate={onDuplicate} onDelete={onDelete} onClose={onClose} />
        </>
      }
      second={
        <>
          <FieldRow>
            <DecimalField label={t("roomMap:inspector.xLabel")} prefix="X" value={item.x} unit="m" disabled={locked} onCommit={(x) => onUpdate({ x })} />
            <DecimalField label={t("roomMap:inspector.yLabel")} prefix="Y" value={item.y} unit="m" disabled={locked} onCommit={(y) => onUpdate({ y })} />
            <DecimalField
              label={t("roomMap:inspector.widthLabel")}
              prefix={<GlyphWidth />}
              value={item.width}
              min={MIN_SIDE_METRES}
              unit="m"
              disabled={locked}
              onCommit={(width) => onUpdate({ width })}
            />
            <DecimalField
              label={t("roomMap:inspector.depthLabel")}
              prefix={<GlyphDepth />}
              value={item.height}
              min={MIN_SIDE_METRES}
              unit="m"
              disabled={locked}
              onCommit={(height) => onUpdate({ height })}
            />
            {showHeight && model ? (
              <DecimalField
                optional
                label={t("roomMap:inspector.heightLabel")}
                prefix={<GlyphHeight />}
                value={resolveFurnitureTop(item)}
                placeholder={modelTop(model).toFixed(2)}
                min={MIN_SIDE_METRES}
                max={MAX_TOP_METRES}
                unit="m"
                disabled={locked}
                onCommit={(topMeters) => onUpdate({ topMeters })}
              />
            ) : (
              <span />
            )}
            {showHeight && model && (
              <FieldTip>
                <InfoTip label={t("common:hintFor", { label: t("roomMap:inspector.heightLabel") })}>
                  {t("roomMap:inspector.topHint", { metres: modelTop(model).toFixed(2) })}
                </InfoTip>
              </FieldTip>
            )}
            <DecimalField
              label={t("roomMap:inspector.furnitureRotationLabel")}
              prefix={<GlyphRotation />}
              value={item.rotation ?? 0}
              decimals={0}
              step={1}
              min={0}
              max={359}
              normalize={wrapDegrees}
              unit="°"
              disabled={locked}
              onCommit={(rotation) => onUpdate({ rotation })}
            />
          </FieldRow>
        </>
      }
    />
  );
}
