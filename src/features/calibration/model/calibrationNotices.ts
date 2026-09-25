import { OVERLAY_NO_DISPLAY, type DisplayTargetBlockedCode } from "@/shared/contracts/display";
import { LED_TEST_STATUS, type LedTestStatusCode } from "@/shared/contracts/preview";
import type { TranslationKey } from "@/features/i18n/catalogue";

/**
 * One LED Setup error: a localized sentence the user can act on, and the raw
 * backend code and reason kept only as secondary text for a bug report. Never
 * interpolate the backend's English into the sentence itself.
 */
export interface CalibrationNotice {
  key: CalibrationNoticeKey;
  detail: string | null;
}

// Literal keys, not a template: the orphan ratchet reads source text.
export const CALIBRATION_NOTICE_KEYS = {
  overlayNoDisplay: "calibration:overlay.errors.overlayNoDisplay",
  overlayOpenFailed: "calibration:overlay.errors.overlayOpenFailed",
  testPatternBlocked: "calibration:overlay.errors.testPatternBlocked",
  testPatternNoCalibration: "calibration:overlay.errors.testPatternNoCalibration",
  testPatternInvalidLayout: "calibration:overlay.errors.testPatternInvalidLayout",
  testPatternRefused: "calibration:overlay.errors.testPatternRefused",
  testPatternToggleFailed: "calibration:overlay.errors.testPatternToggleFailed",
  displaySwitchBlocked: "calibration:overlay.errors.displaySwitchBlocked",
  displaySwitchFailed: "calibration:overlay.errors.displaySwitchFailed",
  saveFailed: "calibration:overlay.errors.saveFailed",
} as const satisfies Record<string, TranslationKey>;

export type CalibrationNoticeKey = (typeof CALIBRATION_NOTICE_KEYS)[keyof typeof CALIBRATION_NOTICE_KEYS];

/** `CODE: reason`, or the code alone when the backend gave no reason. */
export function noticeDetail(code: string | null, reason: string | null | undefined): string | null {
  const trimmed = reason?.trim() || null;
  if (code && trimmed) return `${code}: ${trimmed}`;
  return code ?? trimmed;
}

/** Why the calibration overlay is not on screen. */
export function overlayBlockedNotice(
  code: DisplayTargetBlockedCode | null,
  reason: string | null,
): CalibrationNotice {
  return {
    key:
      code === OVERLAY_NO_DISPLAY
        ? CALIBRATION_NOTICE_KEYS.overlayNoDisplay
        : CALIBRATION_NOTICE_KEYS.overlayOpenFailed,
    detail: noticeDetail(code, reason),
  };
}

/** A start (or a restart with a new layout) the backend refused. */
export function testPatternRefusalNotice(code: LedTestStatusCode | null): CalibrationNotice {
  if (code === LED_TEST_STATUS.PATTERN_NO_CALIBRATION) {
    return { key: CALIBRATION_NOTICE_KEYS.testPatternNoCalibration, detail: null };
  }
  if (code === LED_TEST_STATUS.PATTERN_INVALID_PARAMS) {
    return { key: CALIBRATION_NOTICE_KEYS.testPatternInvalidLayout, detail: code };
  }
  return { key: CALIBRATION_NOTICE_KEYS.testPatternRefused, detail: code };
}
