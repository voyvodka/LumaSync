import { describe, expect, it } from "vitest";

import {
  AMBILIGHT_CAPTURE_REASON,
  CAPTURE_FAILURE_BUCKET,
  classifyCaptureFailure,
  describeCaptureFailure,
  isAmbilightCaptureReason,
  type AmbilightCaptureReason,
} from "../capture";

describe("classifyCaptureFailure", () => {
  it("routes the four actionable reasons to their own buckets", () => {
    expect(classifyCaptureFailure(AMBILIGHT_CAPTURE_REASON.PERMISSION_DENIED)).toBe(
      CAPTURE_FAILURE_BUCKET.PERMISSION,
    );
    expect(classifyCaptureFailure(AMBILIGHT_CAPTURE_REASON.MONITOR_NOT_FOUND)).toBe(
      CAPTURE_FAILURE_BUCKET.DISPLAY,
    );
    expect(classifyCaptureFailure(AMBILIGHT_CAPTURE_REASON.FRAME_UNAVAILABLE)).toBe(
      CAPTURE_FAILURE_BUCKET.TRANSIENT,
    );
    expect(classifyCaptureFailure(AMBILIGHT_CAPTURE_REASON.UNSUPPORTED_PLATFORM)).toBe(
      CAPTURE_FAILURE_BUCKET.UNSUPPORTED,
    );
  });

  it("routes the non-capture tenant of the same field to `output`", () => {
    expect(classifyCaptureFailure(AMBILIGHT_CAPTURE_REASON.LED_OUTPUT_PORT_UNAVAILABLE)).toBe(
      CAPTURE_FAILURE_BUCKET.OUTPUT,
    );
  });

  it("routes every diagnostic reason to `internal`", () => {
    const diagnostics: AmbilightCaptureReason[] = [
      AMBILIGHT_CAPTURE_REASON.FRAME_LOCK_FAILED,
      AMBILIGHT_CAPTURE_REASON.FRAME_BUFFER_FAILED,
      AMBILIGHT_CAPTURE_REASON.PIXEL_BUFFER_INVALID,
      AMBILIGHT_CAPTURE_REASON.THREAD_JOIN_FAILED,
      AMBILIGHT_CAPTURE_REASON.WINRT_INIT_FAILED,
      AMBILIGHT_CAPTURE_REASON.DISPATCHER_INIT_FAILED,
      AMBILIGHT_CAPTURE_REASON.DISPATCHER_SHUTDOWN_FAILED,
      AMBILIGHT_CAPTURE_REASON.DISPATCHER_CALLBACK_FAILED,
      AMBILIGHT_CAPTURE_REASON.ITEM_CONVERSION_FAILED,
      AMBILIGHT_CAPTURE_REASON.D3D_INIT_FAILED,
      AMBILIGHT_CAPTURE_REASON.MESSAGE_LOOP_FAILED,
      AMBILIGHT_CAPTURE_REASON.THREAD_START_FAILED,
    ];
    for (const reason of diagnostics) {
      expect(classifyCaptureFailure(reason)).toBe(CAPTURE_FAILURE_BUCKET.INTERNAL);
    }
  });

  it("buckets SESSION_START_FAILED as transient — restart is the only honest advice", () => {
    expect(classifyCaptureFailure(AMBILIGHT_CAPTURE_REASON.SESSION_START_FAILED)).toBe(
      CAPTURE_FAILURE_BUCKET.TRANSIENT,
    );
  });

  it("covers every declared reason, so a new one cannot land unbucketed", () => {
    for (const reason of Object.values(AMBILIGHT_CAPTURE_REASON)) {
      expect(isAmbilightCaptureReason(reason)).toBe(true);
    }
  });

  it("falls through to `internal` for an unknown reason rather than throwing", () => {
    expect(classifyCaptureFailure("AMBILIGHT_CAPTURE_SOMETHING_FROM_THE_FUTURE")).toBe(
      CAPTURE_FAILURE_BUCKET.INTERNAL,
    );
    expect(classifyCaptureFailure("total gibberish")).toBe(CAPTURE_FAILURE_BUCKET.INTERNAL);
  });

  it("treats an absent detail as `internal`", () => {
    expect(classifyCaptureFailure(null)).toBe(CAPTURE_FAILURE_BUCKET.INTERNAL);
    expect(classifyCaptureFailure(undefined)).toBe(CAPTURE_FAILURE_BUCKET.INTERNAL);
    expect(classifyCaptureFailure("")).toBe(CAPTURE_FAILURE_BUCKET.INTERNAL);
  });

  it("reads the code out of a `CODE: context` detail", () => {
    expect(classifyCaptureFailure("AMBILIGHT_CAPTURE_PERMISSION_DENIED: SCShareableContent")).toBe(
      CAPTURE_FAILURE_BUCKET.PERMISSION,
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(classifyCaptureFailure("  AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND  ")).toBe(
      CAPTURE_FAILURE_BUCKET.DISPLAY,
    );
  });
});

describe("describeCaptureFailure", () => {
  it("keeps the raw reason so the `internal` copy can quote it", () => {
    expect(describeCaptureFailure("AMBILIGHT_CAPTURE_D3D_INIT_FAILED")).toEqual({
      bucket: CAPTURE_FAILURE_BUCKET.INTERNAL,
      reason: "AMBILIGHT_CAPTURE_D3D_INIT_FAILED",
    });
  });

  it("normalises a missing detail to an empty reason", () => {
    expect(describeCaptureFailure(null)).toEqual({
      bucket: CAPTURE_FAILURE_BUCKET.INTERNAL,
      reason: "",
    });
  });
});
