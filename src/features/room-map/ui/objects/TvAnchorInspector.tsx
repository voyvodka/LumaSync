import { useTranslation } from "react-i18next";

import type { TranslationKey } from "@/features/i18n/catalogue";
import {
  resolveScreenAspect,
  resolveScreenKind,
  SCREEN_ASPECTS,
  SCREEN_KINDS,
  type ScreenAspect,
  type ScreenKind,
  screenHeightPerWidth,
  type TvAnchorPlacement,
} from "@/shared/contracts/roomMap";
import { roundTo } from "@/shared/lib/math";
import { IconTv } from "@/shared/ui/icons";
import { InfoTip } from "@/shared/ui/InfoTip/InfoTip";

import { defaultTvMountHeight } from "../../model/roomAware";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";
import { DecimalField } from "../DecimalField";
import { DockPicker } from "../dock/DockPicker";
import { Actions, FieldRow, FieldTip, InspectorRows, Mark, Note, Spacer, Title } from "../dock/InspectorParts";
import { screenDiagonal, type SizeUnit, SIZE_UNITS, widthForDiagonal } from "../../model/screenSize";
import { GlyphDiagonal, GlyphHeight } from "./fieldGlyphs";

// The worker accepts 0, but a screen centre on the floor is never meant.
const MIN_MOUNT_HEIGHT_M = 0.01;
const AUTO = "auto";

const SCREEN_KIND_LABEL = {
  tv: "roomMap:inspector.screenKind.tv",
  monitor: "roomMap:inspector.screenKind.monitor",
} as const satisfies Record<ScreenKind, TranslationKey>;

export function TvAnchorInspector({
  tv,
  roomHeightMeters,
  autoKind,
  modelChoices,
  outside = false,
  sizeUnit,
  onSizeUnitChange,
  onUpdate,
  onToggleLock,
  onDelete,
  onClose,
}: {
  tv: TvAnchorPlacement;
  /** Its middle sits outside the room's outline. */
  outside?: boolean;
  roomHeightMeters: number;
  /** What the screen reads as with no pick. */
  autoKind: ScreenKind;
  /** The screen kind is drawn only by the 3D room; a build without it does not offer it. */
  modelChoices: boolean;
  sizeUnit: SizeUnit;
  onSizeUnitChange: (unit: SizeUnit) => void;
  onUpdate: (patch: Partial<TvAnchorPlacement>) => void;
  onToggleLock: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const locked = !!tv.locked;
  const defaultMount = defaultTvMountHeight(roomHeightMeters).toFixed(2);
  // A room-height edit can leave an explicit mount above the new ceiling; the
  // worker then rejects the geometry and falls back to legacy sampling.
  const mountAboveCeiling = tv.mountHeightMeters !== undefined && tv.mountHeightMeters > roomHeightMeters;
  const aspect = resolveScreenAspect(tv.screenAspect);
  const ratio = screenHeightPerWidth(aspect);
  // The centre stays put: Hue sampling and a backlight strip both read the screen from it.
  const resize = (width: number, more: Partial<TvAnchorPlacement> = {}) => onUpdate({ ...more, width, x: tv.x - (width - tv.width) / 2 });
  const unit = SIZE_UNITS[sizeUnit];
  const otherUnit: SizeUnit = sizeUnit === "inch" ? "cm" : "inch";

  return (
    <InspectorRows
      first={
        <>
          <Mark>
            <span style={{ color: TYPE_DOT_COLOR.tv, display: "grid" }}>
              <IconTv />
            </span>
          </Mark>
          <Title>{t("roomMap:objectPanel.tvLabel")}</Title>
          {modelChoices && (
            <DockPicker
              label={t("roomMap:inspector.screenKindLabel")}
              value={resolveScreenKind(tv.screenKind) ?? AUTO}
              width={150}
              disabled={locked}
              options={[
                { value: AUTO, label: t("roomMap:inspector.screenKindAuto", { kind: t(SCREEN_KIND_LABEL[autoKind]) }) },
                ...Object.values(SCREEN_KINDS).map((kind) => ({ value: kind, label: t(SCREEN_KIND_LABEL[kind]) })),
              ]}
              onChange={(next) => onUpdate({ screenKind: next === AUTO ? undefined : (next as ScreenKind) })}
            />
          )}
          {modelChoices && (
            <DockPicker
              label={t("roomMap:inspector.screenAspectLabel")}
              value={aspect}
              width={84}
              disabled={locked}
              options={Object.values(SCREEN_ASPECTS).map((value) => ({ value, label: value }))}
              onChange={(next) => {
                const diagonal = screenDiagonal(tv.width, ratio, sizeUnit);
                const shape = next as ScreenAspect;
                resize(widthForDiagonal(diagonal, screenHeightPerWidth(shape), sizeUnit), {
                  screenAspect: shape === SCREEN_ASPECTS.R16_9 ? undefined : shape,
                });
              }}
            />
          )}
          {outside && (
            <Note tone="warning" fit title={t("roomMap:inspector.outsideShapeHint")}>
              {t("roomMap:inspector.outsideShape")}
            </Note>
          )}
          {mountAboveCeiling ? (
            <Note tone="warning" title={t("roomMap:inspector.tvMountHeightAboveCeiling")}>
              {t("roomMap:inspector.tvAboveCeilingShort")}
            </Note>
          ) : (
            <Spacer />
          )}
          <Actions locked={locked} onToggleLock={onToggleLock} onDelete={onDelete} onClose={onClose} />
        </>
      }
      second={
        <>
          <FieldRow>
            <DecimalField first label={t("roomMap:inspector.xLabel")} prefix="X" value={tv.x} unit="m" disabled={locked} onCommit={(x) => onUpdate({ x })} />
            <DecimalField label={t("roomMap:inspector.yLabel")} prefix="Y" value={tv.y} unit="m" disabled={locked} onCommit={(y) => onUpdate({ y })} />
            <DecimalField
              label={t("roomMap:inspector.screenSizeLabel", { width: roundTo(tv.width, 2).toFixed(2), height: roundTo(tv.width * ratio, 2).toFixed(2) })}
              prefix={<GlyphDiagonal />}
              value={screenDiagonal(tv.width, ratio, sizeUnit)}
              decimals={0}
              step={1}
              min={unit.min}
              max={unit.max}
              unit={sizeUnit === "inch" ? "″" : "cm"}
              unitSwitch={{
                label: t(otherUnit === "inch" ? "roomMap:inspector.screenSizeToInch" : "roomMap:inspector.screenSizeToCm"),
                onPress: () => onSizeUnitChange(otherUnit),
              }}
              disabled={locked}
              testId="tv-size"
              onCommit={(diagonal) => resize(widthForDiagonal(diagonal, ratio, sizeUnit))}
            />
            <DecimalField
              optional
              label={t("roomMap:inspector.tvMountHeightLabel")}
              prefix={<GlyphHeight />}
              value={tv.mountHeightMeters}
              placeholder={defaultMount}
              min={MIN_MOUNT_HEIGHT_M}
              max={roomHeightMeters}
              unit="m"
              disabled={locked}
              onCommit={(mountHeightMeters) => onUpdate({ mountHeightMeters })}
            />
            <FieldTip>
              <InfoTip label={t("common:hintFor", { label: t("roomMap:inspector.tvMountHeightLabel") })}>
                {t("roomMap:inspector.tvMountHeightHint", { metres: defaultMount })}
              </InfoTip>
            </FieldTip>
          </FieldRow>
        </>
      }
    />
  );
}
