import { useTranslation } from "react-i18next";

import type { DisplayInfo } from "@/shared/contracts/display";
import { IconDisplayGlyph } from "@/shared/ui/icons";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusPill } from "@/shared/ui/StatusPill";

export interface DisplaysCategoryProps {
  isActive: boolean;
  displays: DisplayInfo[];
}

export function DisplaysCategory({ isActive, displays }: DisplaysCategoryProps) {
  const { t } = useTranslation();

  return (
    <div className="lm-device-cat-body" hidden={!isActive}>
      <div className="lm-device-head">
        <div>
          <h1>{t("device:page.header.displaysTitle")}</h1>
          <div className="lm-device-head-sub">{t("device:page.header.displaysSub")}</div>
        </div>
      </div>
      <div className="lm-device-grid">
        {displays.length === 0 ? (
          <EmptyState body={t("device:page.displays.empty")} />
        ) : (
          displays.map((display) => (
            <div key={display.id} className="lm-dcard is-ghost">
              <div className="lm-dcard-head">
                <div className="lm-dcard-ic"><IconDisplayGlyph /></div>
                <div className="lm-dcard-tx">
                  <div className="lm-dcard-name">
                    <span>{display.label}</span>
                    {display.isPrimary ? (
                      <StatusPill tone="ok">{t("device:page.displays.primary")}</StatusPill>
                    ) : null}
                  </div>
                  <div className="lm-dcard-sub">{`${display.width} × ${display.height}`}</div>
                </div>
              </div>
              <div className="lm-dcard-body">
                <div className="lm-dcard-cell">
                  <div className="lm-dcard-cell-k">{t("device:page.displays.cellId")}</div>
                  <div className="lm-dcard-cell-v">{display.id}</div>
                </div>
                <div className="lm-dcard-cell">
                  <div className="lm-dcard-cell-k">{t("device:page.displays.cellScale")}</div>
                  <div className="lm-dcard-cell-v">{display.scaleFactor.toFixed(1)}x</div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
