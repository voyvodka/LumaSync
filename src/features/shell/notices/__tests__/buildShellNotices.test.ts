import { describe, expect, it } from "vitest";

import { ONBOARDING_STEPS } from "@/features/onboarding/state/onboardingState";
import { CAPTURE_FAILURE_BUCKET } from "@/shared/contracts/capture";
import { HUE_SOLID_COLOR_STATUS } from "@/shared/contracts/hue";
import { HUE_LEFT_OUT_REASON } from "@/shared/contracts/lighting";
import { SECTION_IDS } from "@/shared/contracts/shell";

import { buildShellNotices, type ShellNoticeInput } from "../buildShellNotices";
import { NOTICE_SEVERITY, NOTICE_TIER, NOTICE_VIEW, SHELL_NOTICE_IDS } from "../noticeModel";
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
      expect(notice.message).toBe("shell:notices.messages.capturePermission");
      expect(notice.action?.testId).toBe("capture-permission-settings-button");
      expect(notice.action?.navigates).toBe(true);
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
      expect(notice.message).toBe("shell:notices.messages.startFailed.internalNoReason");
    });

    it("keeps the reason when the backend sent one", () => {
      const notice = byId(
        { startFailure: { bucket: CAPTURE_FAILURE_BUCKET.INTERNAL, reason: "BOOM" } },
        SHELL_NOTICE_IDS.START_FAILED,
      );
      expect(notice.message).toBe("shell:notices.messages.startFailed.internal[reason=BOOM]");
    });

    it.each([
      [CAPTURE_FAILURE_BUCKET.DISPLAY, "shell:notices.messages.startFailed.display"],
      [CAPTURE_FAILURE_BUCKET.TRANSIENT, "shell:notices.messages.startFailed.transient"],
      [CAPTURE_FAILURE_BUCKET.UNSUPPORTED, "shell:notices.messages.startFailed.unsupported"],
      [CAPTURE_FAILURE_BUCKET.OUTPUT, "shell:notices.messages.startFailed.output"],
    ])("says why a %s start failed in one sentence", (bucket, key) => {
      expect(byId({ startFailure: { bucket, reason: "X" } }, SHELL_NOTICE_IDS.START_FAILED).message).toBe(key);
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
      expect(notice.message).toBe("shell:notices.messages.captureStalled.genericNoReason");
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
      [HUE_LEFT_OUT_REASON.UNREACHABLE, "shell:notices.messages.hueLeftOut.unreachable"],
      [HUE_LEFT_OUT_REASON.AUTH, "shell:notices.messages.hueLeftOut.auth"],
      [HUE_LEFT_OUT_REASON.CONFIG, "shell:notices.messages.hueLeftOut.config"],
    ])("says why Hue was left out for the %s reason and opens the Hue devices", (reason, key) => {
      const handlers = makeHandlers();
      const notice = byId({ hueLeftOut: reason }, SHELL_NOTICE_IDS.HUE_LEFT_OUT, handlers);

      expect(notice.message).toBe(key);
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
      expect(notice.message).toBe("shell:notices.messages.stopFailed[targets=common:hotplug.targetLabel.hue]");
    });

    // The only button reaches Hue; claiming a retry for the strip would be false.
    it("tells the user how to stop a strip that would not, instead of offering a button", () => {
      const notice = byId({ stopFailedTargets: ["usb"] }, SHELL_NOTICE_IDS.STOP_FAILED);
      expect(notice.action).toBeUndefined();
      expect(notice.message).toBe("shell:notices.messages.stopFailedUsb[targets=common:hotplug.targetLabel.usb]");
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

    // The card offers the same stop; two labels for one action read as two actions.
    it("labels the stop retry with the Hue card's own stop label", () => {
      expect(byId({ stopFailedTargets: ["hue"] }, SHELL_NOTICE_IDS.STOP_FAILED).action?.label).toBe("hue:actions.stop");
    });

    // Devices → Hue shows each of these as the card's state (#475's overlap table).
    it.each<[string, Partial<ShellNoticeInput>, string]>([
      ...Object.values(HUE_LEFT_OUT_REASON).map(
        (reason) => [`left out: ${reason}`, { hueLeftOut: reason }, SHELL_NOTICE_IDS.HUE_LEFT_OUT] as [string, Partial<ShellNoticeInput>, string],
      ),
      ["boot retry: waiting", { hueBootRetry: "waiting" }, SHELL_NOTICE_IDS.HUE_BOOT_RETRY],
      ["boot retry: gave up", { hueBootRetry: "gaveUp" }, SHELL_NOTICE_IDS.HUE_BOOT_RETRY],
      ["stop failed: Hue", { stopFailedTargets: ["hue"] }, SHELL_NOTICE_IDS.STOP_FAILED],
      ["colour: stream offline", { hueColorNotice: HUE_SOLID_COLOR_STATUS.APPLY_SKIPPED }, SHELL_NOTICE_IDS.HUE_COLOR],
      ["colour: no lights", { hueColorNotice: HUE_SOLID_COLOR_STATUS.APPLY_SKIPPED_NO_LIGHTS }, SHELL_NOTICE_IDS.HUE_COLOR],
    ])("defers to Devices → Hue — %s", (_name, input, id) => {
      expect(byId(input, id).shownBy).toBe(NOTICE_VIEW.DEVICES_HUE);
    });

    // The card knows nothing about the strip, so that half of the message stays.
    it("keeps a stop failure that names the strip on every screen", () => {
      expect(byId({ stopFailedTargets: ["hue", "usb"] }, SHELL_NOTICE_IDS.STOP_FAILED).shownBy).toBeUndefined();
      expect(byId({ stopFailedTargets: ["usb"] }, SHELL_NOTICE_IDS.STOP_FAILED).shownBy).toBeUndefined();
    });
  });

  describe("USB", () => {
    it("says lighting is off, not that it continues, when the unplugged strip was the only output", () => {
      const notice = byId({ usbDisconnectedLightingOff: true }, SHELL_NOTICE_IDS.USB_DISCONNECTED);
      expect(notice.message).toBe("shell:notices.messages.usbDisconnectedLightingOff");
      expect(notice.testId).toBe("usb-disconnect-notice");
    });

    it("never claims a switch to Hue when nothing took over from the unrecognised port", () => {
      const handlers = makeHandlers();
      const notice = byId(
        { usbUnsupported: true, usbUnsupportedHueFallback: false },
        SHELL_NOTICE_IDS.USB_UNSUPPORTED,
        handlers,
      );
      expect(notice.message).toBe("shell:notices.messages.usbUnsupportedNoFallback");
      notice.action?.onClick();
      expect(handlers.openDevices).toHaveBeenCalledWith("usb");
    });
  });

  describe("outputs and calibration", () => {
    // They explain the dim Lights mode buttons, so they go where those are.
    // Full mode used to draw its own copies inline on the Lights page.
    it.each([
      [{ availability: "checking" as const }, SHELL_NOTICE_IDS.OUTPUT_CHECKING],
      [{ availability: "none" as const }, SHELL_NOTICE_IDS.OUTPUT_NONE],
      [{ calibrationRequired: true }, SHELL_NOTICE_IDS.CALIBRATION_REQUIRED],
    ])("shows %o in compact and on the full Lights section, nowhere else", (input, id) => {
      expect(build({ ...input, uiMode: "compact" }).map((n) => n.id)).toEqual([id]);
      expect(build({ ...input, uiMode: "compact", activeSection: SECTION_IDS.DEVICES }).map((n) => n.id)).toEqual([id]);
      expect(build({ ...input, uiMode: "full", activeSection: SECTION_IDS.LIGHTS }).map((n) => n.id)).toEqual([id]);
      for (const section of [SECTION_IDS.DEVICES, SECTION_IDS.LED_SETUP, SECTION_IDS.SYSTEM]) {
        expect(build({ ...input, uiMode: "full", activeSection: section })).toEqual([]);
      }
    });

    it.each(["compact", "full"] as const)(
      "grades no output and calibration as error conditions and checking as info (%s)",
      (uiMode) => {
        for (const [input, id] of [
          [{ availability: "none" as const }, SHELL_NOTICE_IDS.OUTPUT_NONE],
          [{ calibrationRequired: true }, SHELL_NOTICE_IDS.CALIBRATION_REQUIRED],
        ] as const) {
          const notice = byId({ ...input, uiMode }, id);
          expect([notice.tier, notice.severity, notice.kind, notice.dismissible]).toEqual([
            NOTICE_TIER.ERROR_CONDITION,
            NOTICE_SEVERITY.ERROR,
            "condition",
            false,
          ]);
        }
        const checking = byId({ availability: "checking", uiMode }, SHELL_NOTICE_IDS.OUTPUT_CHECKING);
        expect([checking.tier, checking.severity, checking.kind, checking.action]).toEqual([
          NOTICE_TIER.INFO,
          NOTICE_SEVERITY.INFO,
          "condition",
          undefined,
        ]);
      },
    );

    it("sends the user to Devices while the probe is still trying, with no retry", () => {
      const handlers = makeHandlers();
      const notice = byId({ availability: "none", uiMode: "full" }, SHELL_NOTICE_IDS.OUTPUT_NONE, handlers);
      expect(notice.message).toBe("shell:notices.messages.outputNone");
      expect(notice.action?.label).toBe("shell:notices.actions.devices");
      expect(notice.action?.navigates).toBe(true);
      expect(notice.secondaryAction).toBeUndefined();
      notice.action?.onClick();
      expect(handlers.openDevices).toHaveBeenCalledOnce();
      expect(handlers.retryHueProbe).not.toHaveBeenCalled();
    });

    it("offers a retry once the bridge probe gave up, and shows it pending while it runs", () => {
      const handlers = makeHandlers();
      const notice = byId({ availability: "none", hueProbeGaveUp: true }, SHELL_NOTICE_IDS.OUTPUT_NONE, handlers);
      expect(notice.message).toBe("shell:notices.messages.outputNoneStopped");
      // A retry stays where it is, so it carries no arrow.
      expect(notice.action?.navigates).toBeUndefined();
      notice.action?.onClick();
      expect(handlers.retryHueProbe).toHaveBeenCalledOnce();
      // Devices stays one click away beside the retry, as the full-mode banner had it.
      expect(notice.secondaryAction?.label).toBe("shell:notices.actions.devices");
      notice.secondaryAction?.onClick();
      expect(handlers.openDevices).toHaveBeenCalledOnce();

      const pending = byId(
        { availability: "none", hueProbeGaveUp: true, hueProbeChecking: true },
        SHELL_NOTICE_IDS.OUTPUT_NONE,
      );
      expect(pending.action?.pending).toBe(true);
      expect(pending.action?.label).toBe("shell:notices.actions.checking");
    });

    it("leaves calibration unsaid while there is no output to calibrate for", () => {
      for (const uiMode of ["compact", "full"] as const) {
        expect(build({ availability: "none", calibrationRequired: true, uiMode }).map((n) => n.id)).toEqual([
          SHELL_NOTICE_IDS.OUTPUT_NONE,
        ]);
      }
    });

    // A calibrated strip that is merely unplugged must not be told to go and
    // calibrate, and an uncalibrated one that is connected must not be called missing.
    it("keeps the calibration reason distinct from the offline reason", () => {
      expect(build({ calibrationRequired: true, uiMode: "full" }).map((n) => n.id)).toEqual([
        SHELL_NOTICE_IDS.CALIBRATION_REQUIRED,
      ]);
      expect(build({ availability: "none", uiMode: "full" }).map((n) => n.id)).toEqual([SHELL_NOTICE_IDS.OUTPUT_NONE]);
    });

    it.each(["compact", "full"] as const)("explains the calibration lock and opens LED setup (%s)", (uiMode) => {
      const handlers = makeHandlers();
      const notice = byId({ calibrationRequired: true, uiMode }, SHELL_NOTICE_IDS.CALIBRATION_REQUIRED, handlers);
      expect(notice.message).toBe("shell:notices.messages.calibrationRequired");
      expect(notice.action?.label).toBe("shell:notices.actions.ledSetup");
      notice.action?.onClick();
      expect(handlers.openLedSetup).toHaveBeenCalledOnce();
    });
  });

  describe("onboarding", () => {
    // Step 2 and "no reachable output" said the same thing with the same button.
    it("hides 'connect your lights' while the no-output notice says it", () => {
      const step2 = { onboardingStep: ONBOARDING_STEPS.DEVICES, availability: "none" as const };
      expect(build({ ...step2, uiMode: "compact" }).map((n) => n.id)).toEqual([SHELL_NOTICE_IDS.OUTPUT_NONE]);
      // Full shows the no-output notice on Lights only; elsewhere step 2 is the only one saying it.
      expect(build({ ...step2, uiMode: "full", activeSection: SECTION_IDS.LIGHTS }).map((n) => n.id)).toEqual([
        SHELL_NOTICE_IDS.OUTPUT_NONE,
      ]);
      expect(build({ ...step2, uiMode: "full", activeSection: SECTION_IDS.SYSTEM }).map((n) => n.id)).toEqual([
        SHELL_NOTICE_IDS.ONBOARDING,
      ]);
    });

    // Step 3 and "calibration required" said the same thing with the same button.
    it("hides 'calibrate your strip' while the calibration notice says it", () => {
      const step3 = { onboardingStep: ONBOARDING_STEPS.LED_SETUP, calibrationRequired: true };
      expect(build({ ...step3, uiMode: "compact" }).map((n) => n.id)).toEqual([SHELL_NOTICE_IDS.CALIBRATION_REQUIRED]);
      expect(build({ ...step3, uiMode: "full", activeSection: SECTION_IDS.LIGHTS }).map((n) => n.id)).toEqual([
        SHELL_NOTICE_IDS.CALIBRATION_REQUIRED,
      ]);
      expect(build({ ...step3, uiMode: "full", activeSection: SECTION_IDS.DEVICES }).map((n) => n.id)).toEqual([
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

  // The first connect used to switch to LED Setup; it now says so from where
  // the user is.
  describe("LED Setup after the first connect", () => {
    const next = { ledSetupNext: "/dev/cu.usbserial-1420", uiMode: "full" as const };

    it("points at LED Setup from Devices, as a dismissible hint", () => {
      const handlers = makeHandlers();
      const notice = byId({ ...next, activeSection: SECTION_IDS.DEVICES }, SHELL_NOTICE_IDS.LED_SETUP_NEXT, handlers);
      expect(notice).toMatchObject({
        severity: NOTICE_SEVERITY.INFO,
        message: "shell:notices.messages.ledSetupNext",
        dismissible: true,
      });
      expect(notice.action?.navigates).toBe(true);
      notice.action?.onClick();
      expect(handlers.openLedSetup).toHaveBeenCalledOnce();
    });

    it("is gone on LED Setup itself", () => {
      expect(build({ ...next, activeSection: SECTION_IDS.LED_SETUP })).toEqual([]);
    });

    it("gives way to the onboarding step and the calibration notice, which say the same", () => {
      expect(
        build({ ...next, activeSection: SECTION_IDS.DEVICES, onboardingStep: ONBOARDING_STEPS.LED_SETUP }).map((n) => n.id),
      ).toEqual([SHELL_NOTICE_IDS.ONBOARDING]);
      expect(
        build({ ...next, activeSection: SECTION_IDS.LIGHTS, calibrationRequired: true }).map((n) => n.id),
      ).toEqual([SHELL_NOTICE_IDS.CALIBRATION_REQUIRED]);
    });
  });

  describe("update check", () => {
    const FAILURE = { message: "check_for_update not allowed" };

    it("reports a failed background check as a dismissible low-priority event with a retry", () => {
      const handlers = makeHandlers();
      const notice = byId({ updateCheckFailed: FAILURE }, SHELL_NOTICE_IDS.UPDATE_CHECK_FAILED, handlers);

      expect(notice.tier).toBe(NOTICE_TIER.INFO);
      expect(notice.severity).toBe(NOTICE_SEVERITY.INFO);
      expect(notice.kind).toBe("event");
      expect(notice.dismissible).toBe(true);
      expect(notice.message).toBe("shell:notices.messages.updateCheckFailed");
      // The raw message embeds the feed URL and is not the explanation.
      expect(notice.message).not.toContain(FAILURE.message);
      expect(notice.action?.label).toBe("updater:actions.retry");
      expect(notice.action?.pending).toBe(false);
      notice.action?.onClick();
      expect(handlers.retryUpdateCheck).toHaveBeenCalledOnce();
    });

    it("shows the retry as pending while the check it started runs", () => {
      const notice = byId({ updateCheckFailed: FAILURE, updateChecking: true }, SHELL_NOTICE_IDS.UPDATE_CHECK_FAILED);

      expect(notice.action?.label).toBe("updater:checking");
      expect(notice.action?.pending).toBe(true);
    });

    it("sits below everything that concerns the lights, onboarding included", () => {
      const ids = build({
        updateCheckFailed: FAILURE,
        onboardingStep: ONBOARDING_STEPS.LIGHTS,
        availability: "checking",
        usbDisconnected: true,
      }).map((n) => n.id);

      expect(ids[ids.length - 1]).toBe(SHELL_NOTICE_IDS.UPDATE_CHECK_FAILED);
    });

    it("says nothing without a failure", () => {
      expect(build({ updateChecking: true })).toEqual([]);
    });
  });
});
