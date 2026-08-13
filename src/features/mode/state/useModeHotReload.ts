import type { ColorCorrectionConfig, FirmwareProfile } from "@/shared/contracts/device";
import type { HueIntensityPreset } from "@/shared/contracts/hue";

import { LIGHTING_MODE_KIND, type LightingModeConfig } from "../model/contracts";
import type { LightingModeDispatcher } from "./useLightingModeDispatch";
import type { ModeRuntimeConfig } from "./useModeRuntimeConfig";

export interface ModeHotReloadHandlers {
  onHueIntensityPresetChange: (preset: HueIntensityPreset) => void;
  onColorCorrectionChange: (next: ColorCorrectionConfig) => void;
  onFirmwareProfileChange: (next: FirmwareProfile) => void;
}

/**
 * The three settings panels that mutate a cached knob and want the running
 * worker to pick it up without a mode toggle. Each mirrors into the runtime
 * config first, then re-dispatches the current mode through the dedup funnel.
 */
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
      // Hot-reload an in-flight ambilight worker so the new preset takes
      // effect without a mode switch. For non-ambilight modes the preset
      // simply rides along on the next start_lighting_mode dispatch.
      // Routed through the dispatch funnel so back-to-back identical
      // fires (re-render storm, double subscribe) collapse to a single
      // backend invoke instead of spamming the IPC bus.
      if (lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT) {
        void dispatch(lightingMode).catch((error) => {
          console.error("[LumaSync] Failed to hot-reload Hue intensity preset:", error);
        });
      }
    },
    onColorCorrectionChange: (next: ColorCorrectionConfig) => {
      // ColorCorrectionPanel already persisted via shellStore.save() on
      // commit; we mirror the new config into the ref so the very next
      // outgoing set_lighting_mode payload carries it, then hot-reload
      // any in-flight worker so USB + Hue sinks pick up the new pipeline
      // without a mode toggle. Solid / off modes also benefit because
      // the Rust encoder path runs color correction before every sink.
      // Routed through the dispatch funnel so an identical re-fire is
      // dropped — see the Hue intensity preset comment for the why.
      runtimeConfig.setColorCorrection(next);
      void dispatch(lightingMode).catch((error) => {
        console.error("[LumaSync] Failed to hot-reload color correction:", error);
      });
    },
    onFirmwareProfileChange: (next: FirmwareProfile) => {
      // FirmwareProfilePicker already persisted via shellStore.save() on
      // commit; mirror into the ref + trigger a worker restart with the
      // new protocol. Changing firmware profile is a wire-format change
      // on the Rust side so a silent flicker is expected — the USB
      // encoder pipeline rebuilds before the next frame. Dispatched with
      // force=true so the backend always sees the new profile bytes even
      // when the FE signature happened to match a prior fire.
      runtimeConfig.setFirmwareProfile(next);
      void dispatch(lightingMode, { force: true }).catch((error) => {
        console.error("[LumaSync] Failed to hot-reload firmware profile:", error);
      });
    },
  };
}
