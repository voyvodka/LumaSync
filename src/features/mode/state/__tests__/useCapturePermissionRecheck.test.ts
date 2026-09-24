import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SCREEN_CAPTURE_PERMISSION_STATUS } from "@/shared/contracts/capture";

import { CAPTURE_PERMISSION_RECHECK_MS, useCapturePermissionRecheck } from "../useCapturePermissionRecheck";
import type * as captureApiModule from "../../captureApi";

const getScreenCapturePermissionMock = vi.fn<typeof captureApiModule.getScreenCapturePermission>();
vi.mock("../../captureApi", () => ({
  getScreenCapturePermission: () => getScreenCapturePermissionMock(),
}));

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useCapturePermissionRecheck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
    getScreenCapturePermissionMock.mockReset().mockResolvedValue({ code: SCREEN_CAPTURE_PERMISSION_STATUS.DENIED });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks nothing while no permission notice stands", async () => {
    renderHook(() => useCapturePermissionRecheck(false, vi.fn()));
    await tick(CAPTURE_PERMISSION_RECHECK_MS * 5);
    expect(getScreenCapturePermissionMock).not.toHaveBeenCalled();
  });

  it("reports once the probe answers GRANTED", async () => {
    const onGranted = vi.fn();
    renderHook(() => useCapturePermissionRecheck(true, onGranted));

    await tick(CAPTURE_PERMISSION_RECHECK_MS);
    expect(onGranted).not.toHaveBeenCalled();

    getScreenCapturePermissionMock.mockResolvedValue({ code: SCREEN_CAPTURE_PERMISSION_STATUS.GRANTED });
    await tick(CAPTURE_PERMISSION_RECHECK_MS);
    expect(onGranted).toHaveBeenCalledOnce();
  });

  it("checks at once when the window comes back from System Settings", async () => {
    const onGranted = vi.fn();
    renderHook(() => useCapturePermissionRecheck(true, onGranted));
    getScreenCapturePermissionMock.mockResolvedValue({ code: SCREEN_CAPTURE_PERMISSION_STATUS.GRANTED });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(onGranted).toHaveBeenCalledOnce();
  });

  // The probe reads a failed call as NOT_REQUIRED; that must not clear a
  // notice that is still true.
  it("never clears on anything but GRANTED", async () => {
    const onGranted = vi.fn();
    getScreenCapturePermissionMock.mockResolvedValue({ code: SCREEN_CAPTURE_PERMISSION_STATUS.NOT_REQUIRED });
    renderHook(() => useCapturePermissionRecheck(true, onGranted));

    await tick(CAPTURE_PERMISSION_RECHECK_MS * 3);
    expect(onGranted).not.toHaveBeenCalled();
  });

  it("does not poll a hidden window", async () => {
    setVisibility("hidden");
    renderHook(() => useCapturePermissionRecheck(true, vi.fn()));
    await tick(CAPTURE_PERMISSION_RECHECK_MS * 3);
    expect(getScreenCapturePermissionMock).not.toHaveBeenCalled();
  });
});
