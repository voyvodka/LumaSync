import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CAPTURE_FAILURE_BUCKET } from "@/shared/contracts/capture";
import { HUE_LEFT_OUT_REASON } from "@/shared/contracts/lighting";

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
      hueLeftOut={null}
      captureStalled={null}
      hueColorNotice={null}
      onOpenCaptureSettings={onOpenCaptureSettings}
      {...overrides}
    />,
  );
  return { onOpenCaptureSettings };
}

describe("ShellNotices", () => {
  // "Screen capture failed ()." shipped when the backend sent no details.
  it("never renders empty parentheses for a reasonless failure", () => {
    renderNotices({ startFailure: { bucket: CAPTURE_FAILURE_BUCKET.INTERNAL, reason: "" } });
    expect(screen.getByTestId("capture-start-failed-notice")).toHaveTextContent(
      "common:captureFailed.internalNoReason",
    );
  });

  it("keeps the reason when the backend sent one", () => {
    renderNotices({ startFailure: { bucket: CAPTURE_FAILURE_BUCKET.INTERNAL, reason: "BOOM" } });
    expect(screen.getByTestId("capture-start-failed-notice")).toHaveTextContent(
      /^common:captureFailed\.internal$/,
    );
  });

  it("uses the reasonless stall copy when the stall carries no reason", () => {
    renderNotices({ captureStalled: { bucket: CAPTURE_FAILURE_BUCKET.INTERNAL, reason: "" } });
    expect(screen.getByTestId("capture-stalled-notice")).toHaveTextContent(
      "common:captureStalled.genericNoReason",
    );
  });

  // The stack sat on top of the StatusBar's shortcut hints and version label.
  it("clears the status bar", () => {
    renderNotices({
      startFailure: { bucket: CAPTURE_FAILURE_BUCKET.INTERNAL, reason: "" },
      statusBarHeightPx: 24,
    });
    expect(screen.getByTestId("capture-start-failed-notice").style.bottom).toBe("32px");
  });

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

  it.each([
    [HUE_LEFT_OUT_REASON.UNREACHABLE, "common:hueLeftOut.unreachable"],
    [HUE_LEFT_OUT_REASON.AUTH, "common:hueLeftOut.auth"],
    [HUE_LEFT_OUT_REASON.CONFIG, "common:hueLeftOut.config"],
  ])("says why Hue was left out for the %s reason", (reason, key) => {
    renderNotices({ hueLeftOut: reason });

    const notice = screen.getByTestId("hue-left-out-notice");
    expect(notice).toHaveTextContent(key);
    expect(notice).toHaveAttribute("role", "status");
  });

  it("stacks the Hue notice above a start failure from the same apply", () => {
    renderNotices({
      hueLeftOut: HUE_LEFT_OUT_REASON.UNREACHABLE,
      startFailure: { bucket: CAPTURE_FAILURE_BUCKET.PERMISSION, reason: "" },
    });

    expect(screen.getByTestId("hue-left-out-notice").style.transform).toBe("translateY(-3.5rem)");
  });
});
