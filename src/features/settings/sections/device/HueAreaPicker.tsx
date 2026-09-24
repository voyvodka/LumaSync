import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import { cx } from "@/shared/ui/cx";
import { IconInfo } from "@/shared/ui/icons";

import type { HueAreaChoice } from "./useHueAreaChoice";

interface HueAreaPickerProps {
  areaGroups: UseHueOnboardingResult["areaGroups"];
  choice: HueAreaChoice;
}

/**
 * The entertainment-area list. Toggle buttons, not a radio group: the list
 * only highlights, and the card footer's Confirm commits — so a Tab stop per
 * area costs less than teaching a roving focus to a list this short.
 */
export function HueAreaPicker({ areaGroups, choice }: HueAreaPickerProps) {
  const { t } = useTranslation();
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const { draftId, pick, changing } = choice;
  const areas = areaGroups.flatMap((group) => group.areas);
  const draftIsHeld = areas.some((area) => area.activeStreamer && area.id === draftId);

  // "Change area" sat in the footer this list replaces, so its focus would
  // otherwise fall to the document.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!changing) return;
    const list = listRef.current;
    const target = list?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? list?.querySelector<HTMLElement>("button");
    target?.focus();
  }, [changing]);

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
        <div className="lm-hue-area-list" role="group" aria-labelledby={labelId} ref={listRef}>
          {areas.map((area, index) => {
            const channelsId = `${baseId}-${index}-ch`;
            const heldId = `${baseId}-${index}-held`;
            const held = Boolean(area.activeStreamer);
            const pressed = draftId === area.id;
            return (
              <button
                key={area.id}
                type="button"
                className={cx("lm-hue-area-item", pressed && "is-on", held && "is-blocked")}
                aria-pressed={pressed}
                // Still focusable, so the reason it cannot be picked is read out.
                aria-disabled={held || undefined}
                aria-label={area.name}
                aria-describedby={held ? `${channelsId} ${heldId}` : channelsId}
                onClick={() => { if (!held) pick(area.id); }}
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
      {/* State G: another app is streaming to the highlighted area. */}
      {draftIsHeld ? (
        <div className="lm-hue-repair is-error" style={{ marginTop: "6px" }}>
          <IconInfo />
          <div className="lm-hue-repair-tx">
            <div className="lm-hue-repair-title">{t("hue:areas.conflictTitle")}</div>
            <div className="lm-hue-repair-sub">{t("hue:areas.conflictHint")}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
