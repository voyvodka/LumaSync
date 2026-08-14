import type { ColorCorrectionConfig, FirmwareProfile, LedChipType } from "@/shared/contracts/device";
import type { HueIntensityPreset } from "@/shared/contracts/hue";

import { LIGHTING_MODE_KIND, type LightingModeConfig } from "../model/contracts";
import type { LightingModeDispatcher } from "./useLightingModeDispatch";
import type { ModeRuntimeConfig } from "./useModeRuntimeConfig";

export interface ModeHotReloadHandlers {
  onHueIntensityPresetChange: (preset: HueIntensityPreset) => void;
  onColorCorrectionChange: (next: ColorCorrectionConfig) => void;
  onFirmwareProfileChange: (next: FirmwareProfile) => void;
  onChipTypeChange: (next: LedChipType) => void;
  onSelectedDisplayIdChange: (next: string) => void;
}

/** Settings panels that mutate a cached knob and want the running worker to pick
 *  it up without a mode toggle: mirror into the runtime config, then re-dispatch. */
export function useModeHotReload(
  runtimeConfig: ModeRuntimeConfig,
  dispatch: LightingModeDispatcher,
  lightingMode: LightingModeConfig,
): ModeHotReloadHandlers {
  // Deliberately rebuilt each render, matching the prop bag these used to sit
  // in: a hand-written dep list here is a stale-closure surface for no gain.
  return {
    onHueIntensityPresetChange: (preset: HueIntensityPreset) => {
      runtimeConfig.setLightingSmoothingPreset(preset);
      // Hot-reload so an in-flight worker picks the preset up without a mode
      // switch; non-ambilight modes just ride the next dispatch. Through the
      // funnel, so an identical re-fire collapses instead of spamming IPC.
      if (lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT) {
        void dispatch(lightingMode).catch((error) => {
          console.error("[LumaSync] Failed to hot-reload Hue intensity preset:", error);
        });
      }
    },
    onColorCorrectionChange: (next: ColorCorrectionConfig) => {
      // The panel already persisted; mirroring into the ref is what makes the
      // next payload carry it. Solid and off benefit too — Rust runs colour
      // correction before every sink, not only the ambilight one.
      runtimeConfig.setColorCorrection(next);
      void dispatch(lightingMode).catch((error) => {
        console.error("[LumaSync] Failed to hot-reload color correction:", error);
      });
    },
    onFirmwareProfileChange: (next: FirmwareProfile) => {
      // A firmware-profile change is a wire-format change, so the flicker while
      // the encoder pipeline rebuilds is expected. `force` is mandatory here:
      // the payload signature can match a prior fire while the bytes differ.
      runtimeConfig.setFirmwareProfile(next);
      void dispatch(lightingMode, { force: true }).catch((error) => {
        console.error("[LumaSync] Failed to hot-reload firmware profile:", error);
      });
    },
    onChipTypeChange: (next: LedChipType) => {
      // Same class of change as the firmware profile: SK6812 is RGBW, so the
      // encoder emits 4 bytes per pixel instead of 3. `force` for the same
      // reason — the signature can match while the wire format differs.
      runtimeConfig.setChipType(next);
      void dispatch(lightingMode, { force: true }).catch((error) => {
        console.error("[LumaSync] Failed to hot-reload chip type:", error);
      });
    },
    onSelectedDisplayIdChange: (next: string) => {
      // Only ambilight binds a capture source; the others ride the next
      // dispatch. `displayId` is in the signature, so no force is needed.
      runtimeConfig.setSelectedDisplayId(next);
      if (lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT) {
        void dispatch(lightingMode).catch((error) => {
          console.error("[LumaSync] Failed to hot-reload capture display:", error);
        });
      }
    },
  };
}
