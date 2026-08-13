import { useCallback, useEffect, useRef } from "react";

import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import type { ColorCorrectionConfig, FirmwareProfile, LedChipType } from "@/shared/contracts/device";
import { DEFAULT_HUE_INTENSITY_PRESET, type HueIntensityPreset } from "@/shared/contracts/hue";

import type { AmbilightPayload, LightingModeConfig } from "../model/contracts";
import {
  hydrateModePayload,
  type ModeRuntimeConfigSnapshot,
} from "./modePayloadHydration";

/** The persisted-state fields the cache is primed from at bootstrap. */
export interface ModeRuntimeConfigPrimeInput {
  selectedDisplayId?: unknown;
  lightingIntensityPreset?: HueIntensityPreset;
  colorCorrection?: ColorCorrectionConfig;
  firmwareProfile?: FirmwareProfile;
  selectedChipType?: LedChipType;
}

export interface ModeRuntimeConfig {
  /** Stamp every cached knob onto an outgoing `set_lighting_mode` payload. */
  hydrate: (mode: LightingModeConfig) => LightingModeConfig;
  /** Synchronous bootstrap prime — must run before the first dispatch. */
  prime: (state: ModeRuntimeConfigPrimeInput) => void;
  setCalibration: (calibration: LedCalibrationConfig | undefined) => void;
  setAmbilight: (ambilight: AmbilightPayload | undefined) => void;
  setLightingSmoothingPreset: (preset: HueIntensityPreset) => void;
  setColorCorrection: (correction: ColorCorrectionConfig) => void;
  setFirmwareProfile: (profile: FirmwareProfile) => void;
  getSelectedDisplayId: () => string | undefined;
}

/** Ref-backed cache of every knob that must ride on *every* `set_lighting_mode`
 *  payload. Refs, not state: the drag path cannot afford a shellStore
 *  round-trip and a stale closure would re-dispatch a stripped payload (H1). */
export function useModeRuntimeConfig(input: {
  calibration: LedCalibrationConfig | undefined;
}): ModeRuntimeConfig {
  // Capture display chosen by the user (v1.4 Platform GAP 2). Hydrated on
  // bootstrap and refreshed when the calibration surface signals a change.
  const selectedDisplayIdRef = useRef<string | undefined>(undefined);
  // Unified lighting smoothing preset (v1.4). Named `hueIntensityPreset`
  // historically; the payload field has since migrated to the unified name.
  const lightingSmoothingPresetRef = useRef<HueIntensityPreset>(DEFAULT_HUE_INTENSITY_PRESET);
  const colorCorrectionRef = useRef<ColorCorrectionConfig | undefined>(undefined);
  const firmwareProfileRef = useRef<FirmwareProfile | undefined>(undefined);
  // The worker sizes its wire packets from the chip type, so it must ride
  // along on every outgoing config.
  const chipTypeRef = useRef<LedChipType | undefined>(undefined);
  // Without this stamp the backend's `total_leds` falls back to 1 and only
  // LED #0 reflects screen content.
  const savedCalibrationRef = useRef<LedCalibrationConfig | undefined>(undefined);
  const savedAmbilightRef = useRef<AmbilightPayload | undefined>(undefined);

  const setCalibration = useCallback((calibration: LedCalibrationConfig | undefined) => {
    savedCalibrationRef.current = calibration;
  }, []);

  const setAmbilight = useCallback((ambilight: AmbilightPayload | undefined) => {
    savedAmbilightRef.current = ambilight;
  }, []);

  const setLightingSmoothingPreset = useCallback((preset: HueIntensityPreset) => {
    lightingSmoothingPresetRef.current = preset;
  }, []);

  const setColorCorrection = useCallback((correction: ColorCorrectionConfig) => {
    colorCorrectionRef.current = correction;
  }, []);

  const setFirmwareProfile = useCallback((profile: FirmwareProfile) => {
    firmwareProfileRef.current = profile;
  }, []);

  const prime = useCallback((state: ModeRuntimeConfigPrimeInput) => {
    selectedDisplayIdRef.current =
      typeof state.selectedDisplayId === "string" && state.selectedDisplayId.length > 0
        ? state.selectedDisplayId
        : undefined;
    // Absent ⇒ DEFAULT_HUE_INTENSITY_PRESET so the ambilight worker always
    // receives a deterministic preset. The other three stay undefined and let
    // the backend's #[serde(default)] apply.
    lightingSmoothingPresetRef.current =
      state.lightingIntensityPreset ?? DEFAULT_HUE_INTENSITY_PRESET;
    colorCorrectionRef.current = state.colorCorrection;
    firmwareProfileRef.current = state.firmwareProfile;
    chipTypeRef.current = state.selectedChipType;
  }, []);

  const hydrate = useCallback(
    (mode: LightingModeConfig): LightingModeConfig =>
      hydrateModePayload(mode, {
        selectedDisplayId: selectedDisplayIdRef.current,
        lightingSmoothingPreset: lightingSmoothingPresetRef.current,
        colorCorrection: colorCorrectionRef.current,
        firmwareProfile: firmwareProfileRef.current,
        chipType: chipTypeRef.current,
        savedCalibration: savedCalibrationRef.current,
        savedAmbilight: savedAmbilightRef.current,
      } satisfies ModeRuntimeConfigSnapshot),
    [],
  );

  const getSelectedDisplayId = useCallback(() => selectedDisplayIdRef.current, []);

  // Mirror effect only — bootstrap and the calibration-save callback both
  // prime the ref synchronously, because a dispatch can fire before this
  // flushes and would otherwise ship the prior `totalLeds`.
  useEffect(() => {
    savedCalibrationRef.current = input.calibration;
  }, [input.calibration]);

  return {
    hydrate,
    prime,
    setCalibration,
    setAmbilight,
    setLightingSmoothingPreset,
    setColorCorrection,
    setFirmwareProfile,
    getSelectedDisplayId,
  };
}
