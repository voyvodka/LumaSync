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
import { PREVIEW_OPEN_FAILURE_COPY, type PreviewOpenFailure } from "@/features/preview/previewOpenFailure";
import type { DeviceCategory } from "@/features/settings/sections/DeviceSection";
import { CAPTURE_FAILURE_BUCKET, type CaptureFailureNotice } from "@/shared/contracts/capture";
import { HUE_SOLID_COLOR_STATUS, type HueRuntimeTarget, type HueSolidColorStatusCode } from "@/shared/contracts/hue";
import { HUE_LEFT_OUT_REASON, type HueLeftOutReason } from "@/shared/contracts/lighting";
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
}

export interface ShellNoticeHandlers {
  openCaptureSettings: () => void;
  openDevices: (category?: DeviceCategory) => void;
  openLedSetup: () => void;
  openLights: () => void;
  retryHueProbe?: () => void;
  retryHueStop: () => void;
  completeOnboarding: () => void;
}

const HUE_LEFT_OUT_TITLE: Record<HueLeftOutReason, TranslationKey> = {
  [HUE_LEFT_OUT_REASON.UNREACHABLE]: "shell:notices.titles.hueUnreachable",
  [HUE_LEFT_OUT_REASON.AUTH]: "shell:notices.titles.hueAuth",
  [HUE_LEFT_OUT_REASON.CONFIG]: "shell:notices.titles.hueConfig",
  [HUE_LEFT_OUT_REASON.BUSY]: "shell:notices.titles.hueWaiting",
  [HUE_LEFT_OUT_REASON.BUSY_GAVE_UP]: "shell:notices.titles.hueBusy",
};

const HUE_LEFT_OUT_COPY: Record<HueLeftOutReason, TranslationKey> = {
  [HUE_LEFT_OUT_REASON.UNREACHABLE]: "common:hueLeftOut.unreachable",
  [HUE_LEFT_OUT_REASON.AUTH]: "common:hueLeftOut.auth",
  [HUE_LEFT_OUT_REASON.CONFIG]: "common:hueLeftOut.config",
  [HUE_LEFT_OUT_REASON.BUSY]: "common:hueLeftOut.busy",
  [HUE_LEFT_OUT_REASON.BUSY_GAVE_UP]: "common:hueLeftOut.busyGaveUp",
};

const HUE_BOOT_RETRY_TITLE: Record<BootHueRetryNotice, TranslationKey> = {
  waiting: "shell:notices.titles.hueWaiting",
  gaveUp: "shell:notices.titles.hueBusy",
};

const HUE_BOOT_RETRY_COPY: Record<BootHueRetryNotice, TranslationKey> = {
  waiting: "common:hueBootRetry.waiting",
  gaveUp: "common:hueBootRetry.gaveUp",
};

const ONBOARDING_COPY: Record<Exclude<OnboardingStep, "complete">, { title: TranslationKey; body: TranslationKey; action: TranslationKey }> = {
  [ONBOARDING_STEPS.LIGHTS]: {
    title: "common:ui.onboarding.step1.title",
    body: "common:ui.onboarding.step1.body",
    action: "common:ui.onboarding.step1.action",
  },
  [ONBOARDING_STEPS.DEVICES]: {
    title: "common:ui.onboarding.step2.title",
    body: "common:ui.onboarding.step2.body",
    action: "common:ui.onboarding.step2.action",
  },
  [ONBOARDING_STEPS.LED_SETUP]: {
    title: "common:ui.onboarding.step3.title",
    body: "common:ui.onboarding.step3.body",
    action: "common:ui.onboarding.step3.action",
  },
};

function startFailureBody(failure: CaptureFailureNotice, t: TFunction): string {
  return failure.bucket === CAPTURE_FAILURE_BUCKET.INTERNAL && !failure.reason
    ? t("common:captureFailed.internalNoReason")
    : t(`common:captureFailed.${failure.bucket}` as const, { reason: failure.reason });
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
  });
  const ledSetupAction = {
    label: t("shell:notices.actions.ledSetup"),
    onClick: handlers.openLedSetup,
  };

  const permission =
    input.startFailure?.bucket === CAPTURE_FAILURE_BUCKET.PERMISSION ? input.startFailure : null;
  const startFailure = permission === null ? input.startFailure : null;
  // A start failure means no worker exists, so the two can never co-fire; the
  // start notice wins to keep that invariant obvious if one ever does.
  const stalled = input.startFailure === null ? input.captureStalled : null;
  // Full mode shows these three on the Lights page, beside the controls they
  // explain; only compact has no room for them there.
  const outputNoneShown =
    input.availability === "none" && (compact || input.activeSection === SECTION_IDS.LIGHTS);

  // ── Capture ──────────────────────────────────────────────────────────
  if (permission) {
    notices.push({
      id: SHELL_NOTICE_IDS.CAPTURE_PERMISSION,
      tier: NOTICE_TIER.ERROR_CONDITION,
      severity: NOTICE_SEVERITY.ERROR,
      kind: "condition",
      title: t("shell:notices.titles.capturePermission"),
      body: t("common:captureFailed.permission"),
      action: {
        label: t("common:captureAction.openSettings"),
        onClick: handlers.openCaptureSettings,
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
      title: t("shell:notices.titles.captureStalled"),
      body:
        stalled.bucket === CAPTURE_FAILURE_BUCKET.DISPLAY
          ? t("common:captureStalled.display")
          : stalled.reason
            ? t("common:captureStalled.generic", { reason: stalled.reason })
            : t("common:captureStalled.genericNoReason"),
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
      title: t("shell:notices.titles.startFailed"),
      body: startFailureBody(startFailure, t),
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
    const body = t("common:hotplug.stopFailed", { targets });
    notices.push({
      id: SHELL_NOTICE_IDS.STOP_FAILED,
      tier: NOTICE_TIER.ERROR_EVENT,
      severity: NOTICE_SEVERITY.ERROR,
      kind: "event",
      title: t("shell:notices.titles.stopFailed"),
      // The button only reaches Hue; the strip stops with the mode.
      body: stopFailedTargets.includes("usb") ? `${body} ${t("common:hotplug.stopFailedUsbHint")}` : body,
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
      title: t("shell:notices.titles.previewOpenFailed"),
      body: t(PREVIEW_OPEN_FAILURE_COPY[input.previewOpenFailure]),
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
      title: t(HUE_LEFT_OUT_TITLE[input.hueLeftOut]),
      body: t(HUE_LEFT_OUT_COPY[input.hueLeftOut]),
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
      title: t(HUE_BOOT_RETRY_TITLE[input.hueBootRetry]),
      body: t(HUE_BOOT_RETRY_COPY[input.hueBootRetry]),
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
      title: t("shell:notices.titles.usbDisconnected"),
      body: input.usbDisconnectedLightingOff
        ? t("common:hotplug.usbDisconnectedLightingOff")
        : t("common:hotplug.usbDisconnected"),
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
      title: t("shell:notices.titles.usbUnsupported"),
      body: input.usbUnsupportedHueFallback
        ? t("common:hotplug.unsupportedFallback")
        : t("common:hotplug.unsupportedNoFallback"),
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
      title: t("shell:notices.titles.hueColor"),
      body: noLights ? t("hue:colorNotApplied.noLights") : t("hue:colorNotApplied.streamOffline"),
      action: noLights ? devicesAction("hue") : undefined,
      dismissible: true,
      source: input.hueColorNotice,
      testId: "hue-color-notice",
    });
  }

  // ── Outputs and calibration ──────────────────────────────────────────
  if (compact && input.availability === "none") {
    const offerRetry = input.hueProbeGaveUp && handlers.retryHueProbe !== undefined;
    notices.push({
      id: SHELL_NOTICE_IDS.OUTPUT_NONE,
      tier: NOTICE_TIER.ERROR_CONDITION,
      severity: NOTICE_SEVERITY.ERROR,
      kind: "condition",
      title: t("common:output.offline.title"),
      body: input.hueProbeGaveUp ? t("common:output.offline.stoppedBody") : t("common:output.offline.body"),
      // The stopped copy says the probe gave up, so checking again is the next step.
      action: offerRetry
        ? {
            label: input.hueProbeChecking ? t("common:output.offline.retrying") : t("common:output.offline.retry"),
            onClick: () => handlers.retryHueProbe?.(),
            pending: input.hueProbeChecking,
          }
        : { label: t("common:output.offline.action"), onClick: () => handlers.openDevices() },
      dismissible: false,
      source: input.hueProbeGaveUp,
      testId: "output-none-notice",
    });
  }
  // With nothing to send frames to, calibrating is not the next step.
  if (compact && input.calibrationRequired && input.availability !== "none") {
    notices.push({
      id: SHELL_NOTICE_IDS.CALIBRATION_REQUIRED,
      tier: NOTICE_TIER.ERROR_CONDITION,
      severity: NOTICE_SEVERITY.ERROR,
      kind: "condition",
      title: t("lights:calibrationBanner.title"),
      body: t("lights:calibrationBanner.sub"),
      action: { label: t("lights:calibrationBanner.action"), onClick: handlers.openLedSetup },
      dismissible: false,
      source: true,
      testId: "calibration-required-notice",
    });
  }

  if (compact && input.availability === "checking") {
    notices.push({
      id: SHELL_NOTICE_IDS.OUTPUT_CHECKING,
      tier: NOTICE_TIER.INFO,
      severity: NOTICE_SEVERITY.INFO,
      kind: "condition",
      title: t("common:output.checking"),
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
    // Calibration maps LEDs; a Hue-only setup has none to map.
    (step === ONBOARDING_STEPS.LED_SETUP && !input.localTargetConfigured);
  if (!onboardingHidden) {
    const copy = ONBOARDING_COPY[step];
    const action =
      step === ONBOARDING_STEPS.LIGHTS
        ? // Compact is the Lights screen already, and so is full on Lights.
          compact || input.activeSection === SECTION_IDS.LIGHTS
          ? undefined
          : { label: t(copy.action), onClick: handlers.openLights }
        : step === ONBOARDING_STEPS.DEVICES
          ? { label: t(copy.action), onClick: () => handlers.openDevices() }
          : { label: t(copy.action), onClick: handlers.openLedSetup };
    notices.push({
      id: SHELL_NOTICE_IDS.ONBOARDING,
      tier: NOTICE_TIER.INFO,
      severity: NOTICE_SEVERITY.INFO,
      kind: "condition",
      title: t(copy.title),
      body: t(copy.body),
      step: `${stepIndex(step)}/${ONBOARDING_TOTAL_STEPS}`,
      action,
      dismissible: true,
      onDismiss: handlers.completeOnboarding,
      source: step,
      testId: "onboarding-notice",
    });
  }

  return orderNotices(notices);
}
