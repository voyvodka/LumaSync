import type { CalibrationTemplate, LedCalibrationConfig } from "./contracts";
import { sumSegmentCounts } from "./contracts";

const MANUAL_COUNTS = {
  top: 0,
  left: 0,
  right: 0,
  bottomLeft: 0,
  bottomRight: 0,
} as const;

export const CALIBRATION_TEMPLATES: CalibrationTemplate[] = [
  {
    id: "monitor-24-16-9",
    label: "24\" 16:9",
    counts: { top: 30, left: 18, right: 18, bottomLeft: 14, bottomRight: 14 },
    bottomGapPx: 120,
    startAnchor: "top-start",
    direction: "cw",
  },
  {
    id: "monitor-27-16-9",
    label: "27\" 16:9",
    counts: { top: 36, left: 22, right: 22, bottomLeft: 17, bottomRight: 17 },
    bottomGapPx: 140,
    startAnchor: "top-start",
    direction: "cw",
  },
  {
    id: "monitor-32-16-9",
    label: "32\" 16:9",
    counts: { top: 42, left: 26, right: 26, bottomLeft: 20, bottomRight: 20 },
    bottomGapPx: 160,
    startAnchor: "top-start",
    direction: "cw",
  },
  {
    id: "monitor-27-qhd",
    label: "27\" QHD",
    counts: { top: 38, left: 24, right: 24, bottomLeft: 18, bottomRight: 18 },
    bottomGapPx: 145,
    startAnchor: "top-start",
    direction: "cw",
  },
  {
    id: "monitor-34-ultrawide",
    label: "34\" Ultrawide",
    counts: { top: 48, left: 20, right: 20, bottomLeft: 24, bottomRight: 24 },
    bottomGapPx: 180,
    startAnchor: "top-start",
    direction: "cw",
  },
];

export function toLedCalibrationConfig(template: CalibrationTemplate): LedCalibrationConfig {
  return {
    templateId: template.id,
    counts: { ...template.counts },
    bottomGapPx: template.bottomGapPx,
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
    bottomGapPx: 0,
    startAnchor: "top-start",
    direction: "cw",
    totalLeds: 0,
  };
}
