import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { shellStore } from "@/features/persistence/shellStore";
import { primaryStripOf } from "@/features/strips/model/stripSelectors";
import { FIRMWARE_PROFILE, type FirmwareProfile } from "@/shared/contracts/device";
import type { TvAnchorPlacement } from "@/shared/contracts/roomMap";

/**
 * What both Lights windows read from the saved state besides the mode: the strip's firmware
 * profile (Adalight carries no brightness byte, so brightness is shown locked) and the room map's
 * TV anchor (room-aware Hue). Chosen on other pages, so a return here reads them again.
 */
export function useLightsModel(): {
  brightnessLocked: boolean;
  brightnessTitle: string | undefined;
  tvAnchor: TvAnchorPlacement | null;
} {
  const { t } = useTranslation();
  const [firmwareProfile, setFirmwareProfile] = useState<FirmwareProfile | undefined>(undefined);
  const [tvAnchor, setTvAnchor] = useState<TvAnchorPlacement | null>(null);
  useEffect(() => {
    let cancelled = false;
    shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        setFirmwareProfile(primaryStripOf(state)?.hardware.firmwareProfile);
        setTvAnchor(state.roomMap?.tvAnchor ?? null);
      })
      .catch((error: unknown) => {
        console.error("[LumaSync] reading what Lights shows besides the mode failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const brightnessLocked = firmwareProfile === FIRMWARE_PROFILE.ADALIGHT;
  return {
    brightnessLocked,
    brightnessTitle: brightnessLocked ? t("lights:led.firmwareProfile.brightnessDisabledTooltip") : undefined,
    tvAnchor,
  };
}
