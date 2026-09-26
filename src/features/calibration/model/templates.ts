import type { LedCalibrationConfig } from "./contracts";

const MANUAL_COUNTS = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
} as const;

export function resetToManual(): LedCalibrationConfig {
  return {
    counts: { ...MANUAL_COUNTS },
    bottomMissing: 0,
    cornerOwnership: "horizontal",
    visualPreset: "vivid",
    startAnchor: "top-start",
    direction: "cw",
    totalLeds: 0,
  };
}
