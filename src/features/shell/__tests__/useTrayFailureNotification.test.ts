import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApplyOutputsOutcome, LightingOrigin, LightingOutcome } from "@/shared/contracts/lightingRuntime";
import type { NotificationPayload, NotificationResult } from "@/shared/contracts/platform";
import { outputsResult } from "@/test/lightingRuntime";

const showNotificationMock = vi.fn<(payload: NotificationPayload) => Promise<NotificationResult>>();
let windowVisible = false;

vi.mock("@/features/platform/platformApi", () => ({
  showNotification: (payload: NotificationPayload) => showNotificationMock(payload),
}));

vi.mock("../windowVisibility", () => ({
  isWindowVisible: () => windowVisible,
}));

vi.mock("@/features/i18n/i18n", () => ({
  i18next: { t: (key: string) => key },
}));

const { TRAY_FAILURE_COALESCE_MS, useTrayFailureNotification } = await import("../useTrayFailureNotification");

const permissionDenied: Partial<ApplyOutputsOutcome> = {
  applyStatus: { code: "AMBILIGHT_MODE_START_FAILED", message: "", details: "AMBILIGHT_CAPTURE_PERMISSION_DENIED" },
};

function outcome(
  requestId: number,
  code: Parameters<typeof outputsResult>[0] = "OUTPUTS_START_FAILED",
  extra: Partial<ApplyOutputsOutcome> = permissionDenied,
  origin: LightingOrigin = "tray",
): LightingOutcome {
  const answer = outputsResult(code, undefined, extra);
  return { requestId, origin, status: answer.status, outcome: answer.outcome };
}

type Props = { last: LightingOutcome | null | undefined };

function mount() {
  const view = renderHook(({ last }: Props) => useTrayFailureNotification(last), {
    initialProps: { last: undefined } as Props,
  });
  // The first snapshot: nothing to say about it.
  view.rerender({ last: null });
  return view;
}

describe("useTrayFailureNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    windowVisible = false;
    showNotificationMock.mockResolvedValue({ status: "shown" });
  });

  // Tray Ambilight without screen recording, window hidden: nothing anywhere said so.
  it("raises one OS notification for a tray choice that failed while the window is hidden", async () => {
    const view = mount();

    view.rerender({ last: outcome(1) });

    await waitFor(() => expect(showNotificationMock).toHaveBeenCalledOnce());
    expect(showNotificationMock).toHaveBeenCalledWith({
      title: "tray:outcomeTitle",
      body: "shell:notices.messages.capturePermission",
      kind: "error",
    });
  });

  it("coalesces the same failure repeated, and says it again once the window has passed", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const view = mount();

    view.rerender({ last: outcome(1) });
    view.rerender({ last: outcome(2) });
    view.rerender({ last: outcome(3) });
    expect(showNotificationMock).toHaveBeenCalledOnce();

    now.mockReturnValue(1_000 + TRAY_FAILURE_COALESCE_MS);
    view.rerender({ last: outcome(4) });
    expect(showNotificationMock).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("says a different failure, and the same one again after a choice that ran", () => {
    const view = mount();

    view.rerender({ last: outcome(1) });
    view.rerender({ last: outcome(2, "OUTPUTS_CALIBRATION_REQUIRED", {}) });
    expect(showNotificationMock).toHaveBeenCalledTimes(2);

    view.rerender({ last: outcome(3, "OUTPUTS_APPLIED", {}) });
    view.rerender({ last: outcome(4, "OUTPUTS_CALIBRATION_REQUIRED", {}) });
    expect(showNotificationMock).toHaveBeenCalledTimes(3);
  });

  it("leaves a visible window's notice to say it", () => {
    windowVisible = true;
    const view = mount();

    view.rerender({ last: outcome(1) });

    expect(showNotificationMock).not.toHaveBeenCalled();
  });

  it("says nothing for a choice that ran, one another surface made, or one seen before", () => {
    const view = mount();

    view.rerender({ last: outcome(1, "OUTPUTS_APPLIED", {}) });
    view.rerender({ last: outcome(2, "OUTPUTS_START_FAILED", permissionDenied, "popup") });
    view.rerender({ last: outcome(2) });

    expect(showNotificationMock).not.toHaveBeenCalled();
  });

  it("does not raise an answer from before the window was open", () => {
    const view = renderHook(({ last }: Props) => useTrayFailureNotification(last), {
      initialProps: { last: undefined } as Props,
    });

    view.rerender({ last: outcome(9) });

    expect(showNotificationMock).not.toHaveBeenCalled();
  });
});
