import { useTranslation } from "react-i18next";

import type { TvAnchorPlacement } from "@/shared/contracts/roomMap";
import { Header, InspectorNumberField, InspectorOptionalNumberField } from "./InspectorPrimitives";
import { defaultTvMountHeight } from "../../model/roomAware";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";

// The worker accepts 0, but a screen centre on the floor is never meant.
const MIN_MOUNT_HEIGHT_M = 0.01;

export function TvAnchorInspector({
  tv,
  roomHeightMeters,
  onUpdate,
  onToggleLock,
}: {
  tv: TvAnchorPlacement;
  roomHeightMeters: number;
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
      <div className="lm-room-dock-fields-wide">
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
          label={t("roomMap:inspector.tvDepthLabel")}
          value={tv.height}
          step={0.05}
          min={0.02}
          unit="m"
          disabled={locked}
          onCommit={(next) => onUpdate({ height: next })}
        />
        <InspectorOptionalNumberField
          id="tv-mount"
          label={t("roomMap:inspector.tvMountHeightLabel")}
          value={tv.mountHeightMeters}
          placeholder={defaultMount}
          min={MIN_MOUNT_HEIGHT_M}
          max={roomHeightMeters}
          unit="m"
          disabled={locked}
          describedBy="tv-mount-hint"
          onCommit={(next) => onUpdate({ mountHeightMeters: next })}
        />
        <p id="tv-mount-hint" className="lm-room-dock-field-hint">
          {mountAboveCeiling
            ? t("roomMap:inspector.tvMountHeightAboveCeiling")
            : t("roomMap:inspector.tvMountHeightHint", { metres: defaultMount })}
        </p>
      </div>
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
