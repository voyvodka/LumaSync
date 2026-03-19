import type { CalibrationTemplate, LedCalibrationConfig } from "./contracts";

export const CALIBRATION_TEMPLATES: CalibrationTemplate[] = [];

export function applyTemplate(templateId: string): LedCalibrationConfig {
  return {
    templateId,
    counts: {
      top: 0,
      left: 0,
      right: 0,
      bottomLeft: 0,
      bottomRight: 0,
    },
    bottomGapPx: 0,
    startAnchor: "top-start",
    direction: "cw",
    totalLeds: 0,
  };
}

export function resetToManual(): LedCalibrationConfig {
  return {
    counts: {
      top: 0,
      left: 0,
      right: 0,
      bottomLeft: 0,
      bottomRight: 0,
    },
    bottomGapPx: 0,
    startAnchor: "top-start",
    direction: "cw",
    totalLeds: 0,
  };
}
