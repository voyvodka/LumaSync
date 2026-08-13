import { useTranslation } from "react-i18next";

import type { TvAnchorPlacement } from "@/shared/contracts/roomMap";
import { Header, InspectorNumberField } from "./InspectorPrimitives";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";

export function TvAnchorInspector({
  tv,
  onUpdate,
  onToggleLock,
}: {
  tv: TvAnchorPlacement;
  onUpdate: (patch: Partial<TvAnchorPlacement>) => void;
  onToggleLock: () => void;
}) {
  const { t } = useTranslation();
  const locked = !!tv.locked;
  return (
    <>
      <Header
        typeLabel={t("roomMap:inspector.typeTv")}
        name={t("roomMap:objectPanel.tvLabel")}
        dotColor={TYPE_DOT_COLOR.tv}
      />
      <InspectorNumberField
        id="tv-w"
        label={t("roomMap:inspector.widthLabel")}
        value={tv.width}
        step={0.05}
        min={0.05}
        unit="m"
        disabled={locked}
        onCommit={(next) => onUpdate({ width: next })}
      />
      <InspectorNumberField
        id="tv-h"
        label={t("roomMap:inspector.heightLabel")}
        value={tv.height}
        step={0.05}
        min={0.02}
        unit="m"
        disabled={locked}
        onCommit={(next) => onUpdate({ height: next })}
      />
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
