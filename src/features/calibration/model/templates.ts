import type { CalibrationTemplate, LedCalibrationConfig } from "./contracts";
import { sumSegmentCounts } from "./contracts";

const MANUAL_COUNTS = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
} as const;

export const CALIBRATION_TEMPLATES: CalibrationTemplate[] = [
  {
    id: "monitor-24-16-9",
    label: "24\" 16:9",
    counts: { top: 30, right: 18, bottom: 28, left: 18 },
    bottomMissing: 0,
    cornerOwnership: "horizontal",
    visualPreset: "vivid",
    startAnchor: "top-start",
    direction: "cw",
  },
  {
    id: "monitor-27-16-9",
    label: "27\" 16:9",
    counts: { top: 36, right: 22, bottom: 34, left: 22 },
    bottomMissing: 0,
    cornerOwnership: "horizontal",
    visualPreset: "vivid",
    startAnchor: "top-start",
    direction: "cw",
  },
  {
    id: "monitor-32-16-9",
    label: "32\" 16:9",
    counts: { top: 42, right: 26, bottom: 40, left: 26 },
    bottomMissing: 0,
    cornerOwnership: "horizontal",
    visualPreset: "vivid",
    startAnchor: "top-start",
    direction: "cw",
  },
  {
    id: "monitor-27-qhd",
    label: "27\" QHD",
    counts: { top: 38, right: 24, bottom: 36, left: 24 },
    bottomMissing: 0,
    cornerOwnership: "horizontal",
    visualPreset: "vivid",
    startAnchor: "top-start",
    direction: "cw",
  },
  {
    id: "monitor-34-ultrawide",
    label: "34\" Ultrawide",
    counts: { top: 48, right: 20, bottom: 48, left: 20 },
    bottomMissing: 0,
    cornerOwnership: "horizontal",
    visualPreset: "vivid",
    startAnchor: "top-start",
    direction: "cw",
  },
];

export function toLedCalibrationConfig(template: CalibrationTemplate): LedCalibrationConfig {
  return {
    templateId: template.id,
    counts: { ...template.counts },
    bottomMissing: template.bottomMissing,
    cornerOwnership: template.cornerOwnership,
    visualPreset: template.visualPreset,
    startAnchor: template.startAnchor,
    direction: template.direction,
    totalLeds: sumSegmentCounts(template.counts),
  };
}

export function applyTemplate(templateId: string): LedCalibrationConfig {
  const template = CALIBRATION_TEMPLATES.find((candidate) => candidate.id === templateId);
  if (!template) {
    return resetToManual();
  }

  return toLedCalibrationConfig(template);
}

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
