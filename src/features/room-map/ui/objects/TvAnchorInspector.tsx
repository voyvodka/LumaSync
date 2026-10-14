import { useTranslation } from "react-i18next";

import type { TranslationKey } from "@/features/i18n/catalogue";
import { resolveScreenKind, SCREEN_KINDS, type ScreenKind, type TvAnchorPlacement } from "@/shared/contracts/roomMap";
import { Segmented } from "@/shared/ui/Segmented/Segmented";
import chips from "./FurnitureInspector.module.css";
import { Header } from "./InspectorPrimitives";
import { defaultTvMountHeight } from "../../model/roomAware";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";
import { DecimalField, FieldHint, FieldPair } from "../DecimalField";
import { GlyphDepth, GlyphHeight, GlyphWidth } from "./fieldGlyphs";

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
  onUpdate,
  onToggleLock,
}: {
  tv: TvAnchorPlacement;
  roomHeightMeters: number;
  /** What the screen reads as with no pick. */
  autoKind: ScreenKind;
  /** The screen kind is drawn only by the 3D room; a build without it does not offer it. */
  modelChoices: boolean;
  onUpdate: (patch: Partial<TvAnchorPlacement>) => void;
  onToggleLock: () => void;
}) {
  const { t } = useTranslation();
  const locked = !!tv.locked;
  const defaultMount = defaultTvMountHeight(roomHeightMeters).toFixed(2);
  // A room-height edit can leave an explicit mount above the new ceiling; the
  // worker then rejects the geometry and falls back to legacy sampling.
  const mountAboveCeiling =
    tv.mountHeightMeters !== undefined && tv.mountHeightMeters > roomHeightMeters;
  return (
    <>
      <Header
        typeLabel={t("roomMap:inspector.typeTv")}
        name={t("roomMap:objectPanel.tvLabel")}
        dotColor={TYPE_DOT_COLOR.tv}
      />
      {modelChoices && (
      <div className={chips.group}>
        <span className={`lm-room-dock-field-label ${chips.label}`}>{t("roomMap:inspector.screenKindLabel")}</span>
        <Segmented
          className={chips.row}
          ariaLabel={t("roomMap:inspector.screenKindLabel")}
          value={resolveScreenKind(tv.screenKind) ?? AUTO}
          disabled={locked}
          options={[
            {
              value: AUTO,
              label: t("roomMap:inspector.screenKindAuto", { kind: t(SCREEN_KIND_LABEL[autoKind]) }),
              className: chips.chip,
            },
            ...Object.values(SCREEN_KINDS).map((kind) => ({
              value: kind,
              label: t(SCREEN_KIND_LABEL[kind]),
              className: chips.chip,
            })),
          ]}
          onChange={(next) => onUpdate({ screenKind: next === AUTO ? undefined : (next as ScreenKind) })}
        />
      </div>
      )}
      <FieldPair>
        <DecimalField
          label={t("roomMap:inspector.xLabel")}
          prefix="X"
          value={tv.x}
          unit="m"
          disabled={locked}
          onCommit={(x) => onUpdate({ x })}
        />
        <DecimalField
          label={t("roomMap:inspector.yLabel")}
          prefix="Y"
          value={tv.y}
          unit="m"
          disabled={locked}
          onCommit={(y) => onUpdate({ y })}
        />
      </FieldPair>
      <FieldPair>
        <DecimalField
          label={t("roomMap:inspector.widthLabel")}
          prefix={<GlyphWidth />}
          value={tv.width}
          min={0.05}
          unit="m"
          disabled={locked}
          onCommit={(width) => onUpdate({ width })}
        />
        <DecimalField
          label={t("roomMap:inspector.tvDepthLabel")}
          prefix={<GlyphDepth />}
          value={tv.height}
          min={0.02}
          unit="m"
          disabled={locked}
          onCommit={(height) => onUpdate({ height })}
        />
      </FieldPair>
      <FieldPair>
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
          describedBy="tv-mount-hint"
          onCommit={(mountHeightMeters) => onUpdate({ mountHeightMeters })}
        />
        <span />
      </FieldPair>
      <FieldHint id="tv-mount-hint">
        {mountAboveCeiling
          ? t("roomMap:inspector.tvMountHeightAboveCeiling")
          : t("roomMap:inspector.tvMountHeightHint", { metres: defaultMount })}
      </FieldHint>
      <button
        type="button"
        className="lm-room-dock-inspect-action"
        onClick={onToggleLock}
        aria-pressed={locked}
      >
        {locked ? t("roomMap:objectPanel.unlock") : t("roomMap:objectPanel.lock")}
      </button>
      <p className="lm-room-dock-field-hint">{t("roomMap:inspector.tvHint")}</p>
    </>
  );
}
