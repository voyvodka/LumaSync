export type LedDirection = "cw" | "ccw";

export type LedStartAnchor =
  | "top-start"
  | "top-end"
  | "left-start"
  | "left-end"
  | "right-start"
  | "right-end"
  | "bottom-left-start"
  | "bottom-left-end"
  | "bottom-right-start"
  | "bottom-right-end";

export interface LedSegmentCounts {
  top: number;
  left: number;
  right: number;
  bottomLeft: number;
  bottomRight: number;
}

export interface LedCalibrationConfig {
  templateId?: string;
  counts: LedSegmentCounts;
  bottomGapPx: number;
  startAnchor: LedStartAnchor;
  direction: LedDirection;
  totalLeds: number;
}

export interface CalibrationTemplate {
  id: string;
  label: string;
  config: LedCalibrationConfig;
}
