import type { RefObject } from "react";
import { useTranslation } from "react-i18next";

import { HUE_AREA_CHANNELS_STATUS } from "@/shared/contracts/hue";
import { useHeldFlag } from "@/shared/lib/useHeldFlag";

import type { HueAreaState } from "../../model/hueAreaState";
import { Note } from "./InspectorParts";

export interface PaletteHueArea {
  state: HueAreaState;
  zoneCount: number;
  /** The area's lights on this map. */
  lightCount: number;
  /** Last channel-fetch code. A failed read must not look like an empty area. */
  channelsStatus: string | null;
  refreshing: boolean;
  onRefresh?: () => void;
  onNavigateToDevices?: () => void;
}

/** The Hue area's state at the end of a dock row: what is missing and the way to fix it, or the
 *  zones it has and a refresh. */
export function HueAreaNote({ hue, noteRef }: { hue: PaletteHueArea; noteRef: RefObject<HTMLSpanElement | null> }) {
  const { t } = useTranslation();
  const refreshing = useHeldFlag(hue.refreshing);
  const { state } = hue;

  if (state.kind !== "ready") {
    const offline = state.kind === "not-configured" && state.orphanedAreaId;
    const title =
      state.kind === "no-area"
        ? t("roomMap:hueZones.areaState.noAreaTitle")
        : offline
          ? t("roomMap:hueZones.areaState.offlineTitle")
          : t("roomMap:hueZones.areaState.notConfiguredTitle");
    const hint =
      state.kind === "no-area"
        ? t("roomMap:hueZones.areaState.noAreaHint")
        : offline
          ? t("roomMap:hueZones.areaState.offlineHint")
          : t("roomMap:hueZones.areaState.notConfiguredHint");
    return (
      <Note
        ref={noteRef}
        tone="warning"
        title={hint}
        action={
          hue.onNavigateToDevices
            ? {
                label:
                  state.kind === "no-area" ? t("roomMap:hueZones.areaState.noAreaCta") : t("roomMap:hueZones.areaState.notConfiguredCta"),
                onClick: hue.onNavigateToDevices,
              }
            : undefined
        }
      >
        {title}
      </Note>
    );
  }

  // EMPTY is a clean answer — the area really has no lights — so only the
  // genuinely unread codes may claim the screen is showing stale data.
  const empty = hue.channelsStatus === HUE_AREA_CHANNELS_STATUS.EMPTY;
  const unread = hue.channelsStatus != null && hue.channelsStatus !== HUE_AREA_CHANNELS_STATUS.OK && !empty;
  return (
    <Note
      ref={noteRef}
      tone={unread || empty ? "info" : "ok"}
      title={
        unread
          ? t("roomMap:hueZones.areaState.unreadHint")
          : empty
            ? t("roomMap:hueZones.areaState.emptyHint")
            : t("roomMap:hueZones.areaState.readyHint")
      }
      action={
        hue.onRefresh
          ? {
              label: refreshing ? t("roomMap:hueZones.areaState.refreshing") : t("roomMap:hueZones.areaState.refresh"),
              onClick: hue.onRefresh,
              pending: refreshing,
            }
          : undefined
      }
    >
      {hue.zoneCount > 0
        ? t("roomMap:hueZones.areaState.readyZones", {
            count: hue.lightCount,
            // Its own plural: one key on the light count read "1 zones".
            zones: t("roomMap:hueZones.areaState.zoneCount", { count: hue.zoneCount }),
          })
        : t("roomMap:hueZones.areaState.ready", { count: hue.lightCount })}
    </Note>
  );
}
