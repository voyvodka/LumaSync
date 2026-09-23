import type { TFunction } from "i18next";
import { vi, type Mock } from "vitest";

import { SECTION_IDS } from "@/shared/contracts/shell";

import type { ShellNoticeHandlers, ShellNoticeInput } from "../buildShellNotices";

/** Returns the key, with any interpolation values appended so a test can tell them apart. */
export const keyT = ((key: string, options?: Record<string, unknown>) => {
  if (!options) return key;
  const values = Object.entries(options)
    .filter(([name]) => name !== "defaultValue")
    .map(([name, value]) => `${name}=${String(value)}`);
  return values.length > 0 ? `${key}[${values.join(",")}]` : key;
}) as unknown as TFunction;

/** Nothing to say: every source quiet, outputs ready, onboarding done. */
export const QUIET_INPUT: ShellNoticeInput = {
  uiMode: "compact",
  activeSection: SECTION_IDS.LIGHTS,
  availability: "ready",
  hueProbeGaveUp: false,
  hueProbeChecking: false,
  calibrationRequired: false,
  startFailure: null,
  captureStalled: null,
  stopFailedTargets: null,
  previewOpenFailure: null,
  hueLeftOut: null,
  hueBootRetry: null,
  usbDisconnected: false,
  usbDisconnectedLightingOff: false,
  usbUnsupported: false,
  usbUnsupportedHueFallback: true,
  hueColorNotice: null,
  onboardingStep: null,
  localTargetConfigured: true,
};

export function makeHandlers(): { [K in keyof Required<ShellNoticeHandlers>]: Mock } {
  return {
    openCaptureSettings: vi.fn(),
    openDevices: vi.fn(),
    openLedSetup: vi.fn(),
    openLights: vi.fn(),
    retryHueProbe: vi.fn(),
    retryHueStop: vi.fn(),
    completeOnboarding: vi.fn(),
  };
}
