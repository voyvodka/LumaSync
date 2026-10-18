import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { shellStore } from "@/features/persistence/shellStore";
import { primaryStripOf } from "@/features/strips/model/stripSelectors";
import { FIRMWARE_PROFILE } from "@/shared/contracts/device";
import type { LightingRuntimeSnapshot } from "@/shared/contracts/lightingRuntime";
import type {
  AmbilightPayload,
  EffectPayload,
  LightingModeConfig,
  SolidColorPayload,
} from "@/shared/contracts/mode";

interface Remembered {
  solid?: SolidColorPayload;
  ambilight?: AmbilightPayload;
  effect?: EffectPayload;
}

/**
 * What the popup's stage shows: the running mode with every mode's last settings, as the main
 * window keeps them. The snapshot carries only what runs, so the others come from what was saved
 * and from what ran while the popup was open — the stage dimmed under Off shows the mode the power
 * button brings back, not its defaults. Each at the one shared brightness. Also whether the strip
 * takes a brightness at all: Adalight carries no brightness byte.
 */
export function usePopupStage(snapshot: LightingRuntimeSnapshot | null): {
  mode: LightingModeConfig;
  brightnessLocked: boolean;
  brightnessTitle: string | undefined;
} {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<Remembered>({});
  const [brightnessLocked, setBrightnessLocked] = useState(false);
  useEffect(() => {
    let cancelled = false;
    shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        const mode = state.lightingMode;
        setSaved({
          solid: mode?.solid ?? undefined,
          ambilight: mode?.ambilight ?? undefined,
          effect: mode?.effect ?? undefined,
        });
        setBrightnessLocked(primaryStripOf(state)?.hardware.firmwareProfile === FIRMWARE_PROFILE.ADALIGHT);
      })
      .catch((error: unknown) => {
        console.error("[LumaSync] ControlPopupApp reading the saved modes failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const remembered = useRef<Remembered>({});
  const running = snapshot?.mode;
  const brightness = snapshot?.brightness;
  const mode = useMemo<LightingModeConfig>(() => {
    if (running?.solid) remembered.current.solid = running.solid;
    if (running?.ambilight) remembered.current.ambilight = running.ambilight;
    if (running?.effect) remembered.current.effect = running.effect;
    const shared = <T extends { brightness: number }>(payload: T | undefined) =>
      payload && brightness !== undefined ? { ...payload, brightness } : payload;
    return {
      ...(running ?? { kind: "off" }),
      solid: shared(running?.solid ?? remembered.current.solid ?? saved.solid),
      ambilight: shared(running?.ambilight ?? remembered.current.ambilight ?? saved.ambilight),
      effect: shared(running?.effect ?? remembered.current.effect ?? saved.effect),
    };
  }, [running, brightness, saved]);

  return {
    mode,
    brightnessLocked,
    brightnessTitle: brightnessLocked ? t("lights:led.firmwareProfile.brightnessDisabledTooltip") : undefined,
  };
}
