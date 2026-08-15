// A validation failure used to reach the user as its wire code —
// `NO_LEDS_CONFIGURED: counts` — in both languages.

import { describe, expect, it } from "vitest";

import enCalibration from "@/locales/en/calibration";
import trCalibration from "@/locales/tr/calibration";
import { validateCalibrationConfig } from "../model/validation";
import type { LedCalibrationConfig } from "../model/contracts";

const CODES = [
  "COUNTS_REQUIRED",
  "SEGMENT_NEGATIVE",
  "TOTAL_MISMATCH",
  "BOTTOM_MISSING_NEGATIVE",
  "BOTTOM_MISSING_EXCEEDS_BOTTOM",
  "NO_LEDS_CONFIGURED",
] as const;

function messages(catalogue: typeof enCalibration) {
  return (catalogue.page as { validation: Record<string, string> }).validation;
}

describe("calibration validation messages", () => {
  it("has a sentence for every code the validator can emit, in both languages", () => {
    for (const code of CODES) {
      expect(messages(enCalibration)[code], `EN is missing ${code}`).toBeTruthy();
      expect(messages(trCalibration)[code], `TR is missing ${code}`).toBeTruthy();
    }
  });

  it("never shows the wire code itself", () => {
    for (const code of CODES) {
      expect(messages(enCalibration)[code]).not.toContain(code);
      expect(messages(trCalibration)[code]).not.toContain(code);
    }
  });

  it("covers what the validator actually produces for an empty room", () => {
    const empty = {
      counts: { top: 0, right: 0, bottom: 0, left: 0 },
      bottomMissing: 0,
      cornerOwnership: "horizontal",
      visualPreset: "vivid",
      startAnchor: "left-end",
      direction: "cw",
      totalLeds: 0,
    } as LedCalibrationConfig;

    const { errors } = validateCalibrationConfig(empty);

    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(messages(enCalibration)[error.code], `EN is missing ${error.code}`).toBeTruthy();
    }
  });
});
