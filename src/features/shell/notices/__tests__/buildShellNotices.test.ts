import { describe, expect, it } from "vitest";

import { ONBOARDING_STEPS } from "@/features/onboarding/state/onboardingState";
import { CAPTURE_FAILURE_BUCKET } from "@/shared/contracts/capture";
import { HUE_SOLID_COLOR_STATUS } from "@/shared/contracts/hue";
import { HUE_LEFT_OUT_REASON } from "@/shared/contracts/lighting";
import { SECTION_IDS } from "@/shared/contracts/shell";

import { buildShellNotices, type ShellNoticeInput } from "../buildShellNotices";
import { SHELL_NOTICE_IDS } from "../noticeModel";
import { keyT, makeHandlers, QUIET_INPUT } from "./noticeFixtures";

function build(overrides: Partial<ShellNoticeInput> = {}, handlers = makeHandlers()) {
  return buildShellNotices({ ...QUIET_INPUT, ...overrides }, handlers, keyT);
}

function byId(overrides: Partial<ShellNoticeInput>, id: string, handlers = makeHandlers()) {
  const notice = build(overrides, handlers).find((n) => n.id === id);
  if (!notice) throw new Error(`no ${id} notice`);
  return notice;
}

const PERMISSION = { bucket: CAPTURE_FAILURE_BUCKET.PERMISSION, reason: "AMBILIGHT_CAPTURE_PERMISSION_DENIED" };

describe("buildShellNotices", () => {
  it("says nothing when nothing is wrong", () => {
    expect(build()).toEqual([]);
  });

  // The toasts shared screen slots and covered each other; one ordered queue
  // decides what is on top.
  it("orders every source by tier: error conditions, error events, warnings, info", () => {
    const everything: Partial<ShellNoticeInput> = {
      availability: "checking",
      calibrationRequired: true,
      captureStalled: { bucket: CAPTURE_FAILURE_BUCKET.DISPLAY, reason: "" },
      stopFailedTargets: ["hue"],
      previewOpenFailure: "CONTROL_POPUP_FAILED",
      hueLeftOut: HUE_LEFT_OUT_REASON.AUTH,
      usbDisconnected: true,
      usbUnsupported: true,
      hueColorNotice: HUE_SOLID_COLOR_STATUS.APPLY_SKIPPED,
      onboardingStep: ONBOARDING_STEPS.LIGHTS,
    };
    // The builder lists notices by source (outputs after Hue and USB); only
    // the tier sort puts "calibration required" above them.
    expect(build(everything).map((n) => n.id)).toEqual([
      SHELL_NOTICE_IDS.CAPTURE_STALLED,
      SHELL_NOTICE_IDS.CALIBRATION_REQUIRED,
      SHELL_NOTICE_IDS.STOP_FAILED,
      SHELL_NOTICE_IDS.PREVIEW_OPEN_FAILED,
      SHELL_NOTICE_IDS.HUE_LEFT_OUT,
      SHELL_NOTICE_IDS.USB_DISCONNECTED,
      SHELL_NOTICE_IDS.USB_UNSUPPORTED,
      SHELL_NOTICE_IDS.HUE_COLOR,
      SHELL_NOTICE_IDS.OUTPUT_CHECKING,
      SHELL_NOTICE_IDS.ONBOARDING,
    ]);

    // The permission condition leads its tier, then "no output".
    expect(
      build({ ...everything, availability: "none", startFailure: PERMISSION }).map((n) => n.id).slice(0, 3),
    ).toEqual([SHELL_NOTICE_IDS.CAPTURE_PERMISSION, SHELL_NOTICE_IDS.OUTPUT_NONE, SHELL_NOTICE_IDS.STOP_FAILED]);
    const transient = { bucket: CAPTURE_FAILURE_BUCKET.TRANSIENT, reason: "X" };
    const ids = build({ ...everything, startFailure: transient }).map((n) => n.id);
    expect(ids.indexOf(SHELL_NOTICE_IDS.START_FAILED)).toBeGreaterThan(ids.indexOf(SHELL_NOTICE_IDS.CALIBRATION_REQUIRED));
    expect(ids.indexOf(SHELL_NOTICE_IDS.START_FAILED)).toBeLessThan(ids.indexOf(SHELL_NOTICE_IDS.STOP_FAILED));
  });

  describe("capture", () => {
    it("treats a denied permission as a lasting condition with the settings deep link", () => {
      const handlers = makeHandlers();
      const notice = byId({ startFailure: PERMISSION }, SHELL_NOTICE_IDS.CAPTURE_PERMISSION, handlers);

      expect(notice.kind).toBe("condition");
      expect(notice.dismissible).toBe(false);
      expect(notice.body).toBe("common:captureFailed.permission");
      expect(notice.action?.testId).toBe("capture-permission-settings-button");
      notice.action?.onClick();
      expect(handlers.openCaptureSettings).toHaveBeenCalledOnce();
    });

    it.each([
      CAPTURE_FAILURE_BUCKET.TRANSIENT,
      CAPTURE_FAILURE_BUCKET.UNSUPPORTED,
      CAPTURE_FAILURE_BUCKET.INTERNAL,
    ])("reports a %s start failure as a dismissible event with no deep link", (bucket) => {
      const notice = byId({ startFailure: { bucket, reason: "SOMETHING" } }, SHELL_NOTICE_IDS.START_FAILED);

      expect(notice.kind).toBe("event");
      expect(notice.dismissible).toBe(true);
      expect(notice.action).toBeUndefined();
    });

    // "Screen capture failed ()." shipped when the backend sent no details.
    it("never renders empty parentheses for a reasonless failure", () => {
      const notice = byId(
        { startFailure: { bucket: CAPTURE_FAILURE_BUCKET.INTERNAL, reason: "" } },
        SHELL_NOTICE_IDS.START_FAILED,
      );
      expect(notice.body).toBe("common:captureFailed.internalNoReason");
    });

    it("keeps the reason when the backend sent one", () => {
      const notice = byId(
        { startFailure: { bucket: CAPTURE_FAILURE_BUCKET.INTERNAL, reason: "BOOM" } },
        SHELL_NOTICE_IDS.START_FAILED,
      );
      expect(notice.body).toBe("common:captureFailed.internal[reason=BOOM]");
    });

    it("sends a vanished display to LED setup, where the copy says to pick another", () => {
      const handlers = makeHandlers();
      byId(
        { startFailure: { bucket: CAPTURE_FAILURE_BUCKET.DISPLAY, reason: "" } },
        SHELL_NOTICE_IDS.START_FAILED,
        handlers,
      ).action?.onClick();
      byId(
        { captureStalled: { bucket: CAPTURE_FAILURE_BUCKET.DISPLAY, reason: "" } },
        SHELL_NOTICE_IDS.CAPTURE_STALLED,
        handlers,
      ).action?.onClick();
      expect(handlers.openLedSetup).toHaveBeenCalledTimes(2);
    });

    it("sends a missing output port to the USB devices", () => {
      const handlers = makeHandlers();
      byId(
        { startFailure: { bucket: CAPTURE_FAILURE_BUCKET.OUTPUT, reason: "" } },
        SHELL_NOTICE_IDS.START_FAILED,
        handlers,
      ).action?.onClick();
      expect(handlers.openDevices).toHaveBeenCalledWith("usb");
    });

    it("uses the reasonless stall copy when the stall carries no reason", () => {
      const notice = byId(
        { captureStalled: { bucket: CAPTURE_FAILURE_BUCKET.INTERNAL, reason: "" } },
        SHELL_NOTICE_IDS.CAPTURE_STALLED,
      );
      expect(notice.body).toBe("common:captureStalled.genericNoReason");
      expect(notice.kind).toBe("condition");
    });

    it("suppresses the stall notice while a start failure is up", () => {
      // A failed start means no worker exists, so a stall beside it would be
      // describing a worker that never ran.
      const ids = build({
        startFailure: { bucket: CAPTURE_FAILURE_BUCKET.TRANSIENT, reason: "X" },
        captureStalled: { bucket: CAPTURE_FAILURE_BUCKET.DISPLAY, reason: "Y" },
      }).map((n) => n.id);
      expect(ids).toEqual([SHELL_NOTICE_IDS.START_FAILED]);
    });
  });

  describe("Hue", () => {
    it.each([
      [HUE_LEFT_OUT_REASON.UNREACHABLE, "common:hueLeftOut.unreachable"],
      [HUE_LEFT_OUT_REASON.AUTH, "common:hueLeftOut.auth"],
      [HUE_LEFT_OUT_REASON.CONFIG, "common:hueLeftOut.config"],
    ])("says why Hue was left out for the %s reason and opens the Hue devices", (reason, key) => {
      const handlers = makeHandlers();
      const notice = byId({ hueLeftOut: reason }, SHELL_NOTICE_IDS.HUE_LEFT_OUT, handlers);

      expect(notice.body).toBe(key);
      expect(notice.data).toEqual({ "data-reason": reason });
      notice.action?.onClick();
      expect(handlers.openDevices).toHaveBeenCalledWith("hue");
    });

    it("keeps the busy wait up as a condition, with nothing to click", () => {
      const notice = byId({ hueLeftOut: HUE_LEFT_OUT_REASON.BUSY }, SHELL_NOTICE_IDS.HUE_LEFT_OUT);
      expect(notice.kind).toBe("condition");
      expect(notice.dismissible).toBe(false);
      expect(notice.action).toBeUndefined();
    });

    it("retries a failed Hue stop through the orchestrator", () => {
      const handlers = makeHandlers();
      const notice = byId({ stopFailedTargets: ["hue"] }, SHELL_NOTICE_IDS.STOP_FAILED, handlers);

      notice.action?.onClick();
      expect(handlers.retryHueStop).toHaveBeenCalledOnce();
      expect(notice.body).not.toContain("stopFailedUsbHint");
    });

    // The only button reaches Hue; claiming a retry for the strip would be false.
    it("tells the user how to stop a strip that would not, instead of offering a button", () => {
      const notice = byId({ stopFailedTargets: ["usb"] }, SHELL_NOTICE_IDS.STOP_FAILED);
      expect(notice.action).toBeUndefined();
      expect(notice.body).toContain("common:hotplug.stopFailedUsbHint");
    });

    it("opens the Hue devices when no light resolved, and offers nothing for a queued colour", () => {
      const handlers = makeHandlers();
      byId({ hueColorNotice: HUE_SOLID_COLOR_STATUS.APPLY_SKIPPED_NO_LIGHTS }, SHELL_NOTICE_IDS.HUE_COLOR, handlers)
        .action?.onClick();
      expect(handlers.openDevices).toHaveBeenCalledWith("hue");
      expect(
        byId({ hueColorNotice: HUE_SOLID_COLOR_STATUS.APPLY_SKIPPED }, SHELL_NOTICE_IDS.HUE_COLOR).action,
      ).toBeUndefined();
    });
  });

  describe("USB", () => {
    it("says lighting is off, not that it continues, when the unplugged strip was the only output", () => {
      const notice = byId({ usbDisconnectedLightingOff: true }, SHELL_NOTICE_IDS.USB_DISCONNECTED);
      expect(notice.body).toBe("common:hotplug.usbDisconnectedLightingOff");
      expect(notice.testId).toBe("usb-disconnect-notice");
    });

    it("never claims a switch to Hue when nothing took over from the unrecognised port", () => {
      const handlers = makeHandlers();
      const notice = byId(
        { usbUnsupported: true, usbUnsupportedHueFallback: false },
        SHELL_NOTICE_IDS.USB_UNSUPPORTED,
        handlers,
      );
      expect(notice.body).toBe("common:hotplug.unsupportedNoFallback");
      notice.action?.onClick();
      expect(handlers.openDevices).toHaveBeenCalledWith("usb");
    });
  });

  describe("outputs and calibration", () => {
    it("shows checking, no output and calibration in compact only — full shows them on the Lights page", () => {
      const inputs: Partial<ShellNoticeInput>[] = [
        { availability: "checking" },
        { availability: "none" },
        { calibrationRequired: true },
      ];
      for (const input of inputs) {
        expect(build({ ...input, uiMode: "compact" })).toHaveLength(1);
        expect(build({ ...input, uiMode: "full" })).toEqual([]);
      }
    });

    it("offers a retry once the bridge probe gave up, and shows it pending while it runs", () => {
      const handlers = makeHandlers();
      const notice = byId({ availability: "none", hueProbeGaveUp: true }, SHELL_NOTICE_IDS.OUTPUT_NONE, handlers);
      expect(notice.body).toBe("common:output.offline.stoppedBody");
      notice.action?.onClick();
      expect(handlers.retryHueProbe).toHaveBeenCalledOnce();

      const pending = byId(
        { availability: "none", hueProbeGaveUp: true, hueProbeChecking: true },
        SHELL_NOTICE_IDS.OUTPUT_NONE,
      );
      expect(pending.action?.pending).toBe(true);
      expect(pending.action?.label).toBe("common:output.offline.retrying");
    });

    it("leaves calibration unsaid while there is no output to calibrate for", () => {
      expect(build({ availability: "none", calibrationRequired: true }).map((n) => n.id)).toEqual([
        SHELL_NOTICE_IDS.OUTPUT_NONE,
      ]);
    });

    it("explains the compact calibration lock and opens LED setup", () => {
      const handlers = makeHandlers();
      const notice = byId({ calibrationRequired: true }, SHELL_NOTICE_IDS.CALIBRATION_REQUIRED, handlers);
      expect(notice.title).toBe("lights:calibrationBanner.title");
      notice.action?.onClick();
      expect(handlers.openLedSetup).toHaveBeenCalledOnce();
    });
  });

  describe("onboarding", () => {
    // Step 2 and "no reachable output" said the same thing with the same button.
    it("hides 'connect your lights' while the no-output notice says it", () => {
      const step2 = { onboardingStep: ONBOARDING_STEPS.DEVICES, availability: "none" as const };
      expect(build({ ...step2, uiMode: "compact" }).map((n) => n.id)).toEqual([SHELL_NOTICE_IDS.OUTPUT_NONE]);
      // Full shows the no-output banner on Lights only; elsewhere step 2 is the only one saying it.
      expect(build({ ...step2, uiMode: "full", activeSection: SECTION_IDS.LIGHTS })).toEqual([]);
      expect(build({ ...step2, uiMode: "full", activeSection: SECTION_IDS.SYSTEM }).map((n) => n.id)).toEqual([
        SHELL_NOTICE_IDS.ONBOARDING,
      ]);
    });

    it("asks to calibrate only when a strip or WLED panel is configured", () => {
      expect(build({ onboardingStep: ONBOARDING_STEPS.LED_SETUP, localTargetConfigured: false })).toEqual([]);
      expect(
        build({ onboardingStep: ONBOARDING_STEPS.LED_SETUP, localTargetConfigured: true }).map((n) => n.id),
      ).toEqual([SHELL_NOTICE_IDS.ONBOARDING]);
    });

    // In compact "Open lights" led where the user already was.
    it("drops the step-1 action where it would lead nowhere", () => {
      const step1 = { onboardingStep: ONBOARDING_STEPS.LIGHTS };
      expect(byId({ ...step1, uiMode: "compact" }, SHELL_NOTICE_IDS.ONBOARDING).action).toBeUndefined();
      expect(
        byId({ ...step1, uiMode: "full", activeSection: SECTION_IDS.LIGHTS }, SHELL_NOTICE_IDS.ONBOARDING).action,
      ).toBeUndefined();

      const handlers = makeHandlers();
      byId({ ...step1, uiMode: "full", activeSection: SECTION_IDS.DEVICES }, SHELL_NOTICE_IDS.ONBOARDING, handlers)
        .action?.onClick();
      expect(handlers.openLights).toHaveBeenCalledOnce();
    });

    it("numbers the step and completes the flow on dismiss", () => {
      const handlers = makeHandlers();
      const notice = byId({ onboardingStep: ONBOARDING_STEPS.DEVICES }, SHELL_NOTICE_IDS.ONBOARDING, handlers);
      expect(notice.step).toBe("2/3");
      expect(notice.dismissible).toBe(true);
      notice.onDismiss?.();
      expect(handlers.completeOnboarding).toHaveBeenCalledOnce();
    });
  });
});
