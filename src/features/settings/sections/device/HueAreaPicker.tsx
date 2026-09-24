import { useId } from "react";
import { useTranslation } from "react-i18next";

import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import { cx } from "@/shared/ui/cx";
import { IconInfo } from "@/shared/ui/icons";

interface HueAreaPickerProps {
  hue: UseHueOnboardingResult;
  readinessDisabled: boolean;
}

/**
 * The entertainment-area list of a freshly paired bridge. Toggle buttons, not
 * a radio group: choosing an area commits it and closes the list, so arrow
 * keys that select as they move would pick whatever they passed first.
 */
export function HueAreaPicker({ hue, readinessDisabled }: HueAreaPickerProps) {
  const { t } = useTranslation();
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const { areaGroups, selectedAreaId, selectArea, revalidateArea, isCheckingReadiness } = hue;
  const areas = areaGroups.flatMap((group) => group.areas);
  const selectedIsHeld = areas.some((area) => area.activeStreamer && area.id === selectedAreaId);

  return (
    <div className="lm-hue-areas">
      <div className="lm-hue-areas-label" id={labelId}>
        {t("hue:areas.selectLabel")}
      </div>
      {areaGroups.length === 0 ? (
        <p style={{ fontFamily: "var(--lm-mono)", fontSize: "10px", color: "var(--lm-ink-faint)", padding: "4px 0" }}>
          {t("hue:areas.empty")}
        </p>
      ) : (
        <div className="lm-hue-area-list" role="group" aria-labelledby={labelId}>
          {areas.map((area, index) => {
            const channelsId = `${baseId}-${index}-ch`;
            const heldId = `${baseId}-${index}-held`;
            const held = Boolean(area.activeStreamer);
            return (
              <button
                key={area.id}
                type="button"
                className={cx(
                  "lm-hue-area-item",
                  selectedAreaId === area.id && "is-on",
                  held && "is-blocked",
                )}
                aria-pressed={selectedAreaId === area.id}
                // Still focusable, so the reason it cannot be picked is read out.
                aria-disabled={held || undefined}
                aria-label={area.name}
                aria-describedby={held ? `${channelsId} ${heldId}` : channelsId}
                onClick={() => { if (!held) selectArea(area.id); }}
              >
                <span className="lm-hue-area-ic" aria-hidden="true" />
                <span className="lm-hue-area-name">{area.name}</span>
                <span className="lm-hue-area-ch" id={channelsId}>
                  {t("hue:areas.channels", { count: area.channelCount ?? 0 })}
                </span>
                {held ? (
                  <span className="lm-hue-area-badge" id={heldId}>
                    {t("hue:areas.activeStreamer")}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      {/* State G: another app is streaming to the chosen area. */}
      {selectedIsHeld ? (
        <div className="lm-hue-repair is-error" style={{ marginTop: "6px" }}>
          <IconInfo />
          <div className="lm-hue-repair-tx">
            <div className="lm-hue-repair-title">{t("hue:areas.conflictTitle")}</div>
            <div className="lm-hue-repair-sub">{t("hue:areas.conflictHint")}</div>
          </div>
        </div>
      ) : null}
      {selectedAreaId ? (
        <button
          type="button"
          className="lm-hue-area-confirm"
          onClick={() => { void revalidateArea(); }}
          disabled={readinessDisabled}
          aria-busy={isCheckingReadiness}
        >
          {isCheckingReadiness ? t("hue:actions.checkingReadiness") : `${t("hue:page.confirmArea")} →`}
        </button>
      ) : null}
    </div>
  );
}
