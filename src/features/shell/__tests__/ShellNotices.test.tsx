import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CAPTURE_FAILURE_BUCKET } from "@/shared/contracts/capture";

import { ShellNotices, type ShellNoticesProps } from "../ShellNotices";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderNotices(overrides: Partial<ShellNoticesProps> = {}) {
  const onOpenCaptureSettings = vi.fn();
  render(
    <ShellNotices
      usbDisconnected={false}
      usbUnsupported={false}
      stopFailedTargets={null}
      startFailure={null}
      captureStalled={null}
      hueColorNotice={null}
      onOpenCaptureSettings={onOpenCaptureSettings}
      {...overrides}
    />,
  );
  return { onOpenCaptureSettings };
}

describe("ShellNotices", () => {
  it("offers the settings deep link on a permission failure", async () => {
    const { onOpenCaptureSettings } = renderNotices({
      startFailure: {
        bucket: CAPTURE_FAILURE_BUCKET.PERMISSION,
        reason: "AMBILIGHT_CAPTURE_PERMISSION_DENIED",
      },
    });

    await userEvent.click(screen.getByTestId("capture-permission-settings-button"));
    expect(onOpenCaptureSettings).toHaveBeenCalledOnce();
  });

  it("renders the mid-stream stall notice on its own", () => {
    renderNotices({
      captureStalled: {
        bucket: CAPTURE_FAILURE_BUCKET.DISPLAY,
        reason: "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
      },
    });

    expect(screen.getByTestId("capture-stalled-notice")).toBeTruthy();
  });

  it("suppresses the stall notice while a start failure is up", () => {
    // A failed start means no worker exists, so a stall toast beside it would
    // be describing a worker that never ran.
    renderNotices({
      startFailure: {
        bucket: CAPTURE_FAILURE_BUCKET.TRANSIENT,
        reason: "AMBILIGHT_CAPTURE_SESSION_START_FAILED",
      },
      captureStalled: {
        bucket: CAPTURE_FAILURE_BUCKET.DISPLAY,
        reason: "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
      },
    });

    expect(screen.getByTestId("capture-start-failed-notice")).toBeTruthy();
    expect(screen.queryByTestId("capture-stalled-notice")).toBeNull();
  });

  it.each([
    CAPTURE_FAILURE_BUCKET.DISPLAY,
    CAPTURE_FAILURE_BUCKET.TRANSIENT,
    CAPTURE_FAILURE_BUCKET.UNSUPPORTED,
    CAPTURE_FAILURE_BUCKET.OUTPUT,
    CAPTURE_FAILURE_BUCKET.INTERNAL,
    // Every other bucket points at something System Settings cannot fix.
  ])("hides the deep link for the %s bucket", (bucket) => {
    renderNotices({ startFailure: { bucket, reason: "SOMETHING_ELSE" } });

    expect(screen.getByTestId("capture-start-failed-notice")).toBeTruthy();
    expect(screen.queryByTestId("capture-permission-settings-button")).toBeNull();
  });
});
