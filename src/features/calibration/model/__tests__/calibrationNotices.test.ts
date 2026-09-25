// LED Setup errors once read "Test pattern blocked (OVERLAY_OPEN_FAILED): <Rust
// English>". The sentence is now the user's; the code rides along as detail.
import { describe, expect, it } from "vitest";

import { DISPLAY_OVERLAY_STATUS, OVERLAY_NO_DISPLAY } from "@/shared/contracts/display";
import { LED_TEST_STATUS } from "@/shared/contracts/preview";

import {
  CALIBRATION_NOTICE_KEYS,
  noticeDetail,
  overlayBlockedNotice,
  testPatternRefusalNotice,
} from "../calibrationNotices";

describe("calibration notices", () => {
  it("keeps the backend's code and reason out of the sentence, as secondary detail", () => {
    const notice = overlayBlockedNotice(DISPLAY_OVERLAY_STATUS.OPEN_FAILED, "window create failed");
    expect(notice.key).toBe(CALIBRATION_NOTICE_KEYS.overlayOpenFailed);
    expect(notice.detail).toBe("OVERLAY_OPEN_FAILED: window create failed");
  });

  it("tells a missing display apart from an overlay that failed to open", () => {
    expect(overlayBlockedNotice(OVERLAY_NO_DISPLAY, null).key).toBe(CALIBRATION_NOTICE_KEYS.overlayNoDisplay);
  });

  it("maps each refusal code to its own sentence", () => {
    expect(testPatternRefusalNotice(LED_TEST_STATUS.PATTERN_NO_CALIBRATION)).toEqual({
      key: CALIBRATION_NOTICE_KEYS.testPatternNoCalibration,
      detail: null,
    });
    expect(testPatternRefusalNotice(LED_TEST_STATUS.PATTERN_INVALID_PARAMS).key).toBe(
      CALIBRATION_NOTICE_KEYS.testPatternInvalidLayout,
    );
    expect(testPatternRefusalNotice(LED_TEST_STATUS.PATTERN_RUNTIME_ERROR)).toEqual({
      key: CALIBRATION_NOTICE_KEYS.testPatternRefused,
      detail: LED_TEST_STATUS.PATTERN_RUNTIME_ERROR,
    });
  });

  it("builds the detail from whatever the backend did give", () => {
    expect(noticeDetail(null, "  disk full ")).toBe("disk full");
    expect(noticeDetail("CODE", null)).toBe("CODE");
    expect(noticeDetail(null, null)).toBeNull();
  });
});
