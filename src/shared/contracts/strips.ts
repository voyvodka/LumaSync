// A strip: one run of LEDs behind one local controller, with the hardware, layout and tuning that
// belong to it. Stored as `ShellState.ledStrips` from schema 8. Rust handoff:
// `src-tauri/src/models/led_strips.rs`, which reads the same shape by the same rules.

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
  /** The user's name for it. Absent until renamed: the UI names a strip after its device, so the
   *  name follows a controller swap until the user chooses one. Never blank when present. */
  name?: string;
  enabled: boolean;
  /** `null`: a layout with no controller bound yet. */
  transport: StripTransport | null;
  hardware: StripHardware;
  layout?: LedCalibrationConfig;
  /** Not read yet: the top-level `colorCorrection` still drives the strip and Hue alike. */
  colorCorrection?: ColorCorrectionConfig;
}

/**
 * The keys one local output was stored in up to schema 7. Frozen in schema 8 — still on disk so a
 * v7 build boots, never written — and read only to derive strips from a file that has no
 * `ledStrips` yet. Only `features/strips/model/legacyStrips.ts` and `persistence/migrations.ts`
 * may import this; `verify:shell-contracts` checks it.
 */
export interface LegacyV7StripKeys {
  /** The port a launch reconnects. */
  lastSuccessfulPort?: string;
  /** The WLED device a launch binds again; the app never wrote it beside a port. */
  lastWledSink?: WledUdpSinkConfig;
  ledCalibration?: LedCalibrationConfig;
  firmwareProfile?: FirmwareProfile;
  selectedChipType?: LedChipType;
  ledColorOrder?: LedColorOrder;
}
