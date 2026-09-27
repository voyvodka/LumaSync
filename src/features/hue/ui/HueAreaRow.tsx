import { useId, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import { PickerList } from "@/shared/ui/PickerList/PickerList";
import { RowButton, RowNote, SettingRow } from "@/shared/ui/SettingRow/SettingRow";

import { HueActionButton } from "./HueBridgeRow";
import type { HueActionId, HueActionSpec } from "./hueStateView";
import type { HueAreaChoice } from "./useHueAreaChoice";
import styles from "./HuePage.module.css";

interface HueAreaRowProps {
  hue: UseHueOnboardingResult;
  choice: HueAreaChoice;
  /** `null` when the state only shows the area. */
  change: HueActionSpec | null;
  refresh: HueActionSpec & { id: HueActionId };
  /** The page's amber action is choosing an area. */
  primary: boolean;
}

/**
 * The entertainment area in use, and a list to pick another from. The list floats from the
 * button that opened it; picking an area is the choice.
 */
export function HueAreaRow({ hue, choice, change, refresh, primary }: HueAreaRowProps) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  const areas = hue.areaGroups.flatMap((group) => group.areas);
  const area = hue.selectedArea;
  // Only where the area can be chosen: a state that just shows it may not have read the list at all.
  const noAreas = change !== null && areas.length === 0 && area === null && !hue.isLoadingAreas;

  const value = area
    ? area.channelCount === undefined
      ? area.name
      : `${area.name} · ${t("hue:areas.channels", { count: area.channelCount })}`
    : t("hue:page.noArea");

  return (
    <SettingRow
      label={t("hue:row.area")}
      value={value}
      testId="hue-area-row"
      control={
        change === null ? null : noAreas ? (
          <HueActionButton action={refresh} />
        ) : (
          <>
            <RowButton
              ref={anchorRef}
              primary={primary}
              onClick={change.onClick}
              disabled={change.disabled}
              aria-expanded={choice.open}
              aria-controls={choice.open ? listId : undefined}
              data-action="changeArea"
            >
              {change.label}
            </RowButton>
            <PickerList
              open={choice.open}
              onClose={choice.close}
              anchorRef={anchorRef}
              side="below"
              id={listId}
              label={t("hue:areas.selectLabel")}
              width="fit"
              items={areas}
              itemKey={(item) => item.id}
              selectedIndex={areas.findIndex((item) => item.id === hue.selectedAreaId)}
              // Held by another app: listed, so the choice is understood, but not pickable.
              isDisabled={(item) => Boolean(item.activeStreamer) && item.id !== hue.selectedAreaId}
              renderItem={(item) => (
                <>
                  <span>{item.name}</span>
                  <span className={styles.optionMeta}>
                    {item.activeStreamer ? t("hue:areas.activeStreamer") : t("hue:areas.channels", { count: item.channelCount ?? 0 })}
                  </span>
                </>
              )}
              onPick={(index) => {
                const picked = areas[index];
                if (picked) choice.pick(picked.id);
                anchorRef.current?.focus();
              }}
            />
          </>
        )
      }
    >
      {noAreas ? <RowNote tone="status">{t("hue:areas.empty")}</RowNote> : null}
    </SettingRow>
  );
}
