import type { LedCalibrationConfig } from "./contracts";

export interface LedSequenceItem {
  index: number;
  segment: string;
  localIndex: number;
}

export function buildLedSequence(_config: LedCalibrationConfig): LedSequenceItem[] {
  return [];
}
