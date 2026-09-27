// A strip: one run of LEDs behind one local controller, with the hardware, layout and tuning that
// belong to it. Rust handoff: `src-tauri/src/models/led_strips.rs`, where the same shape is
// derived from the saved state.

import type { LedCalibrationConfig } from "./calibration";
import type {
  ColorCorrectionConfig,
  FirmwareProfile,
  LedChipType,
  LedColorOrder,
  WledUdpSinkConfig,
} from "./device";

/** Opaque and stable. A strip that already has a room-map placement keeps that placement's id. */
export type StripId = string;

/** The id a strip gets when no room-map placement names one. */
export const FIRST_STRIP_ID: StripId = "strip-1";

export type StripTransport =
  | { kind: "serial"; portName: string }
  | { kind: "wled"; sink: WledUdpSinkConfig };

/** What the controller needs to be told. WLED keeps its chip and colour order on the device. */
export interface StripHardware {
  firmwareProfile?: FirmwareProfile;
  chipType?: LedChipType;
  colorOrder?: LedColorOrder;
}

export interface LedStrip {
  id: StripId;
  enabled: boolean;
  /** `null`: a layout with no controller bound yet. */
  transport: StripTransport | null;
  hardware: StripHardware;
  layout?: LedCalibrationConfig;
  /** Not read yet: the top-level `colorCorrection` still drives the strip and Hue alike. */
  colorCorrection?: ColorCorrectionConfig;
}
