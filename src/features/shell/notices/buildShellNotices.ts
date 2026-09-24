import type { TFunction } from "i18next";

import type { TranslationKey } from "@/features/i18n/catalogue";
import type { BootHueRetryNotice } from "@/features/mode/state/bootHueRetry";
import type { OutputAvailability } from "@/features/mode/model/outputAvailability";
import {
  ONBOARDING_STEPS,
  ONBOARDING_TOTAL_STEPS,
  stepIndex,
  type OnboardingStep,
} from "@/features/onboarding/state/onboardingState";
import type { PreviewOpenFailure } from "@/features/preview/previewOpenFailure";
import type { DeviceCategory } from "@/features/settings/sections/DeviceSection";
import type { UpdateCheckFailure } from "@/features/updater/useUpdateCheckFailedNotice";
import {
  CAPTURE_FAILURE_BUCKET,
  type CaptureFailureBucket,
  type CaptureFailureNotice,
} from "@/shared/contracts/capture";
import { HUE_SOLID_COLOR_STATUS, type HueRuntimeTarget, type HueSolidColorStatusCode } from "@/shared/contracts/hue";
import { HUE_LEFT_OUT_REASON, type HueLeftOutReason } from "@/shared/contracts/lighting";
import { CONTROL_POPUP_STATUS, TWIN_OVERLAY_STATUS } from "@/shared/contracts/preview";
import { SECTION_IDS, type SectionId, type UIMode } from "@/shared/contracts/shell";

import {
  NOTICE_SEVERITY,
  NOTICE_TIER,
  orderNotices,
  SHELL_NOTICE_IDS,
  type ShellNotice,
} from "./noticeModel";

/** Everything the shell knows that a notice can be about. Pure data. */
export interface ShellNoticeInput {
  uiMode: UIMode;
  activeSection: SectionId;
  availability: OutputAvailability;
  hueProbeGaveUp: boolean;
  hueProbeChecking: boolean;
  calibrationRequired: boolean;
  /** A `permission`-bucket failure is the lasting condition, every other bucket an event. */
  startFailure: CaptureFailureNotice | null;
  captureStalled: CaptureFailureNotice | null;
  stopFailedTargets: HueRuntimeTarget[] | null;
  previewOpenFailure: PreviewOpenFailure | null;
  hueLeftOut: HueLeftOutReason | null;
  hueBootRetry: BootHueRetryNotice | null;
  usbDisconnected: boolean;
  usbDisconnectedLightingOff: boolean;
  usbUnsupported: boolean;
  usbUnsupportedHueFallback: boolean;
  hueColorNotice: HueSolidColorStatusCode | null;
  /** The step the onboarding flow would show now, or `null`. */
  onboardingStep: OnboardingStep | null;
  /** A USB strip or WLED panel is bound — the only outputs calibration applies to. */
  localTargetConfigured: boolean;
  /** The startup update check failed; a check the user starts reports through the modal instead. */
  updateCheckFailed: UpdateCheckFailure | null;
  updateChecking: boolean;
}

export interface ShellNoticeHandlers {
  openCaptureSettings: () => void;
  openDevices: (category?: DeviceCategory) => void;
  openLedSetup: () => void;
  openLights: () => void;
  retryHueProbe?: () => void;
  retryHueStop: () => void;
  completeOnboarding: () => void;
  retryUpdateCheck: () => void;
}

const HUE_LEFT_OUT_MESSAGE: Record<HueLeftOutReason, TranslationKey> = {
  [HUE_LEFT_OUT_REASON.UNREACHABLE]: "shell:notices.messages.hueLeftOut.unreachable",
  [HUE_LEFT_OUT_REASON.AUTH]: "shell:notices.messages.hueLeftOut.auth",
  [HUE_LEFT_OUT_REASON.CONFIG]: "shell:notices.messages.hueLeftOut.config",
  [HUE_LEFT_OUT_REASON.BUSY]: "shell:notices.messages.hueLeftOut.busy",
  [HUE_LEFT_OUT_REASON.BUSY_GAVE_UP]: "shell:notices.messages.hueLeftOut.busyGaveUp",
};

const HUE_BOOT_RETRY_MESSAGE: Record<BootHueRetryNotice, TranslationKey> = {
  waiting: "shell:notices.messages.hueBootRetry.waiting",
  gaveUp: "shell:notices.messages.hueBootRetry.gaveUp",
};

/** `permission` is a notice of its own, and `internal` reads its reason. */
const START_FAILED_MESSAGE: Record<Exclude<CaptureFailureBucket, "permission" | "internal">, TranslationKey> = {
  [CAPTURE_FAILURE_BUCKET.DISPLAY]: "shell:notices.messages.startFailed.display",
  [CAPTURE_FAILURE_BUCKET.TRANSIENT]: "shell:notices.messages.startFailed.transient",
  [CAPTURE_FAILURE_BUCKET.UNSUPPORTED]: "shell:notices.messages.startFailed.unsupported",
  [CAPTURE_FAILURE_BUCKET.OUTPUT]: "shell:notices.messages.startFailed.output",
};

const PREVIEW_OPEN_FAILED_MESSAGE: Record<PreviewOpenFailure, TranslationKey> = {
  [TWIN_OVERLAY_STATUS.OPEN_FAILED]: "shell:notices.messages.previewOpenFailed.overlay",
  [TWIN_OVERLAY_STATUS.DISPLAY_NOT_FOUND]: "shell:notices.messages.previewOpenFailed.display",
  [TWIN_OVERLAY_STATUS.UNSUPPORTED_PLATFORM_LIVE]: "shell:notices.messages.previewOpenFailed.unsupported",
  [CONTROL_POPUP_STATUS.FAILED]: "shell:notices.messages.previewOpenFailed.popup",
};

const ONBOARDING_MESSAGE: Record<Exclude<OnboardingStep, "complete">, TranslationKey> = {
  [ONBOARDING_STEPS.LIGHTS]: "shell:notices.messages.onboarding.lights",
  [ONBOARDING_STEPS.DEVICES]: "shell:notices.messages.onboarding.devices",
  [ONBOARDING_STEPS.LED_SETUP]: "shell:notices.messages.onboarding.ledSetup",
};

function startFailureMessage(failure: CaptureFailureNotice, t: TFunction): string {
  if (failure.bucket === CAPTURE_FAILURE_BUCKET.PERMISSION) return t("shell:notices.messages.capturePermission");
  if (failure.bucket === CAPTURE_FAILURE_BUCKET.INTERNAL) {
    // "Screen capture failed ()." shipped when the backend sent no details.
    return failure.reason
      ? t("shell:notices.messages.startFailed.internal", { reason: failure.reason })
      : t("shell:notices.messages.startFailed.internalNoReason");
  }
  return t(START_FAILED_MESSAGE[failure.bucket]);
}

/**
 * Every notice the shell should show right now, in queue order. Which notices
 * exist is decided here and nowhere else. They are listed by source; the tier
 * sort at the end, not this listing, is what puts them in order.
 */
export function buildShellNotices(
  input: ShellNoticeInput,
  handlers: ShellNoticeHandlers,
  t: TFunction,
): ShellNotice[] {
  const notices: ShellNotice[] = [];
  const compact = input.uiMode === "compact";
  const devicesAction = (category?: DeviceCategory) => ({
    label: t("shell:notices.actions.devices"),
    onClick: () => handlers.openDevices(category),
    navigates: true,
  });
  const ledSetupAction = {
    label: t("shell:notices.actions.ledSetup"),
    onClick: handlers.openLedSetup,
    navigates: true,
  };

  const permission =
    input.startFailure?.bucket === CAPTURE_FAILURE_BUCKET.PERMISSION ? input.startFailure : null;
  const startFailure = permission === null ? input.startFailure : null;
  // A start failure means no worker exists, so the two can never co-fire; the
  // start notice wins to keep that invariant obvious if one ever does.
  const stalled = input.startFailure === null ? input.captureStalled : null;
  // No output, checking and calibration explain why the Lights mode buttons
  // are dim, so they show where those buttons are: always in compact, and on
  // the Lights section in full.
  const onLights = compact || input.activeSection === SECTION_IDS.LIGHTS;
  const outputNoneShown = onLights && input.availability === "none";
  // With nothing to send frames to, calibrating is not the next step.
  const calibrationShown = onLights && input.calibrationRequired && input.availability !== "none";

  // ── Capture ──────────────────────────────────────────────────────────
  if (permission) {
    notices.push({
      id: SHELL_NOTICE_IDS.CAPTURE_PERMISSION,
      tier: NOTICE_TIER.ERROR_CONDITION,
      severity: NOTICE_SEVERITY.ERROR,
      kind: "condition",
      message: t("shell:notices.messages.capturePermission"),
      action: {
        label: t("shell:notices.actions.systemSettings"),
        onClick: handlers.openCaptureSettings,
        navigates: true,
        testId: "capture-permission-settings-button",
      },
      dismissible: false,
      source: permission,
      testId: "capture-start-failed-notice",
    });
  }
  if (stalled) {
    notices.push({
      id: SHELL_NOTICE_IDS.CAPTURE_STALLED,
      tier: NOTICE_TIER.ERROR_CONDITION,
      severity: NOTICE_SEVERITY.ERROR,
      kind: "condition",
      message:
        stalled.bucket === CAPTURE_FAILURE_BUCKET.DISPLAY
          ? t("shell:notices.messages.captureStalled.display")
          : stalled.reason
            ? t("shell:notices.messages.captureStalled.generic", { reason: stalled.reason })
            : t("shell:notices.messages.captureStalled.genericNoReason"),
      action: stalled.bucket === CAPTURE_FAILURE_BUCKET.DISPLAY ? ledSetupAction : undefined,
      dismissible: false,
      source: stalled.bucket,
      testId: "capture-stalled-notice",
    });
  }
  if (startFailure) {
    notices.push({
      id: SHELL_NOTICE_IDS.START_FAILED,
      tier: NOTICE_TIER.ERROR_EVENT,
      severity: NOTICE_SEVERITY.ERROR,
      kind: "event",
      message: startFailureMessage(startFailure, t),
      action:
        startFailure.bucket === CAPTURE_FAILURE_BUCKET.DISPLAY
          ? ledSetupAction
          : startFailure.bucket === CAPTURE_FAILURE_BUCKET.OUTPUT
            ? devicesAction("usb")
            : undefined,
      dismissible: true,
      source: startFailure,
      testId: "capture-start-failed-notice",
    });
  }
  const stopFailedTargets = input.stopFailedTargets ?? [];
  if (stopFailedTargets.length > 0) {
    const targets = stopFailedTargets
      .map((target) => t(`common:hotplug.targetLabel.${target}` as const))
      .join(", ");
    notices.push({
      id: SHELL_NOTICE_IDS.STOP_FAILED,
      tier: NOTICE_TIER.ERROR_EVENT,
      severity: NOTICE_SEVERITY.ERROR,
      kind: "event",
      // The button only reaches Hue; the strip stops with the mode.
      message: stopFailedTargets.includes("usb")
        ? t("shell:notices.messages.stopFailedUsb", { targets })
        : t("shell:notices.messages.stopFailed", { targets }),
      action: stopFailedTargets.includes("hue")
        ? { label: t("shell:notices.actions.stopHue"), onClick: handlers.retryHueStop, testId: "stop-failed-retry" }
        : undefined,
      dismissible: true,
      source: input.stopFailedTargets,
      testId: "stop-failed-notice",
    });
  }
  if (input.previewOpenFailure) {
    notices.push({
      id: SHELL_NOTICE_IDS.PREVIEW_OPEN_FAILED,
      tier: NOTICE_TIER.ERROR_EVENT,
      severity: NOTICE_SEVERITY.ERROR,
      kind: "event",
      message: t(PREVIEW_OPEN_FAILED_MESSAGE[input.previewOpenFailure]),
      dismissible: true,
      source: input.previewOpenFailure,
      testId: "preview-open-failed-notice",
    });
  }

  // ── Hue and USB ──────────────────────────────────────────────────────
  if (input.hueLeftOut) {
    // Busy describes a wait still under way, which the retry replaces or clears.
    const waiting = input.hueLeftOut === HUE_LEFT_OUT_REASON.BUSY;
    const opensDevices =
      input.hueLeftOut === HUE_LEFT_OUT_REASON.AUTH ||
      input.hueLeftOut === HUE_LEFT_OUT_REASON.UNREACHABLE ||
      input.hueLeftOut === HUE_LEFT_OUT_REASON.CONFIG;
    notices.push({
      id: SHELL_NOTICE_IDS.HUE_LEFT_OUT,
      tier: NOTICE_TIER.WARNING,
      severity: NOTICE_SEVERITY.WARNING,
      kind: waiting ? "condition" : "event",
      message: t(HUE_LEFT_OUT_MESSAGE[input.hueLeftOut]),
      action: opensDevices ? devicesAction("hue") : undefined,
      dismissible: !waiting,
      source: input.hueLeftOut,
      testId: "hue-left-out-notice",
      data: { "data-reason": input.hueLeftOut },
    });
  }
  // Never co-fires with the left-out notice: that one means a mode is running.
  if (input.hueBootRetry) {
    const waiting = input.hueBootRetry === "waiting";
    notices.push({
      id: SHELL_NOTICE_IDS.HUE_BOOT_RETRY,
      tier: NOTICE_TIER.WARNING,
      severity: NOTICE_SEVERITY.WARNING,
      kind: waiting ? "condition" : "event",
      message: t(HUE_BOOT_RETRY_MESSAGE[input.hueBootRetry]),
      dismissible: !waiting,
      source: input.hueBootRetry,
      testId: "hue-boot-retry-notice",
      data: { "data-state": input.hueBootRetry },
    });
  }
  if (input.usbDisconnected || input.usbDisconnectedLightingOff) {
    notices.push({
      id: SHELL_NOTICE_IDS.USB_DISCONNECTED,
      tier: NOTICE_TIER.WARNING,
      severity: NOTICE_SEVERITY.WARNING,
      kind: "event",
      message: input.usbDisconnectedLightingOff
        ? t("shell:notices.messages.usbDisconnectedLightingOff")
        : t("shell:notices.messages.usbDisconnected"),
      dismissible: true,
      source: input.usbDisconnectedLightingOff ? "lightingOff" : "continuing",
      testId: "usb-disconnect-notice",
    });
  }
  if (input.usbUnsupported) {
    notices.push({
      id: SHELL_NOTICE_IDS.USB_UNSUPPORTED,
      tier: NOTICE_TIER.WARNING,
      severity: NOTICE_SEVERITY.WARNING,
      kind: "event",
      message: input.usbUnsupportedHueFallback
        ? t("shell:notices.messages.usbUnsupportedFallback")
        : t("shell:notices.messages.usbUnsupportedNoFallback"),
      // Only the no-fallback copy sends the user to Devices.
      action: input.usbUnsupportedHueFallback ? undefined : devicesAction("usb"),
      dismissible: true,
      source: input.usbUnsupportedHueFallback,
      testId: "usb-unsupported-notice",
    });
  }
  if (input.hueColorNotice) {
    const noLights = input.hueColorNotice === HUE_SOLID_COLOR_STATUS.APPLY_SKIPPED_NO_LIGHTS;
    notices.push({
      id: SHELL_NOTICE_IDS.HUE_COLOR,
      tier: NOTICE_TIER.WARNING,
      severity: NOTICE_SEVERITY.WARNING,
      kind: "event",
      message: noLights
        ? t("shell:notices.messages.hueColorNoLights")
        : t("shell:notices.messages.hueColorStreamOffline"),
      action: noLights ? devicesAction("hue") : undefined,
      dismissible: true,
      source: input.hueColorNotice,
      testId: "hue-color-notice",
    });
  }

  // ── Outputs and calibration ──────────────────────────────────────────
  if (outputNoneShown) {
    const offerRetry = input.hueProbeGaveUp && handlers.retryHueProbe !== undefined;
    const openDevices = devicesAction();
    notices.push({
      id: SHELL_NOTICE_IDS.OUTPUT_NONE,
      tier: NOTICE_TIER.ERROR_CONDITION,
      severity: NOTICE_SEVERITY.ERROR,
      kind: "condition",
      message: input.hueProbeGaveUp
        ? t("shell:notices.messages.outputNoneStopped")
        : t("shell:notices.messages.outputNone"),
      // The stopped copy says the probe gave up, so checking again is the next step.
      action: offerRetry
        ? {
            label: input.hueProbeChecking ? t("shell:notices.actions.checking") : t("shell:notices.actions.checkAgain"),
            onClick: () => handlers.retryHueProbe?.(),
            pending: input.hueProbeChecking,
          }
        : openDevices,
      secondaryAction: offerRetry ? openDevices : undefined,
      dismissible: false,
      source: input.hueProbeGaveUp,
      testId: "output-none-notice",
    });
  }
  if (calibrationShown) {
    notices.push({
      id: SHELL_NOTICE_IDS.CALIBRATION_REQUIRED,
      tier: NOTICE_TIER.ERROR_CONDITION,
      severity: NOTICE_SEVERITY.ERROR,
      kind: "condition",
      message: t("shell:notices.messages.calibrationRequired"),
      action: ledSetupAction,
      dismissible: false,
      source: true,
      testId: "calibration-required-notice",
    });
  }

  if (onLights && input.availability === "checking") {
    notices.push({
      id: SHELL_NOTICE_IDS.OUTPUT_CHECKING,
      tier: NOTICE_TIER.INFO,
      severity: NOTICE_SEVERITY.INFO,
      kind: "condition",
      message: t("shell:notices.messages.outputChecking"),
      dismissible: false,
      source: true,
      testId: "output-checking",
    });
  }
  // ── Onboarding ───────────────────────────────────────────────────────
  const step = input.onboardingStep;
  const onboardingHidden =
    step === null ||
    step === ONBOARDING_STEPS.COMPLETE ||
    // "Connect your lights" says what the no-output notice already says.
    (step === ONBOARDING_STEPS.DEVICES && outputNoneShown) ||
    // "Calibrate your LEDs" says what the calibration notice already says.
    (step === ONBOARDING_STEPS.LED_SETUP && calibrationShown) ||
    // Calibration maps LEDs; a Hue-only setup has none to map.
    (step === ONBOARDING_STEPS.LED_SETUP && !input.localTargetConfigured);
  if (!onboardingHidden) {
    const action =
      step === ONBOARDING_STEPS.LIGHTS
        ? // Compact is the Lights screen already, and so is full on Lights.
          onLights
          ? undefined
          : { label: t("shell:notices.actions.lights"), onClick: handlers.openLights, navigates: true }
        : step === ONBOARDING_STEPS.DEVICES
          ? devicesAction()
          : ledSetupAction;
    notices.push({
      id: SHELL_NOTICE_IDS.ONBOARDING,
      tier: NOTICE_TIER.INFO,
      severity: NOTICE_SEVERITY.INFO,
      kind: "condition",
      message: t(ONBOARDING_MESSAGE[step]),
      step: `${stepIndex(step)}/${ONBOARDING_TOTAL_STEPS}`,
      action,
      dismissible: true,
      onDismiss: handlers.completeOnboarding,
      source: step,
      testId: "onboarding-notice",
    });
  }

  // ── Updates ──────────────────────────────────────────────────────────
  // Listed last: nothing about the lights depends on it, so it is never the
  // notice that pushes a first-run step out of view.
  if (input.updateCheckFailed) {
    notices.push({
      id: SHELL_NOTICE_IDS.UPDATE_CHECK_FAILED,
      tier: NOTICE_TIER.INFO,
      severity: NOTICE_SEVERITY.INFO,
      kind: "event",
      message: t("shell:notices.messages.updateCheckFailed"),
      action: {
        label: input.updateChecking ? t("updater:checking") : t("updater:actions.retry"),
        onClick: handlers.retryUpdateCheck,
        pending: input.updateChecking,
        testId: "update-check-retry",
      },
      dismissible: true,
      source: input.updateCheckFailed,
      testId: "update-check-failed-notice",
    });
  }

  return orderNotices(notices);
}
