import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import {
  AMBILIGHT_CAPTURE_REASON,
  CAPTURE_FAILURE_BUCKET,
  describeCaptureFailure,
  isScreenCaptureBlocked,
  type CaptureFailureNotice,
} from "@/shared/contracts/capture";
import { HUE_SOLID_COLOR_STATUS, type HueRuntimeTarget, type HueRuntimeTriggerSource } from "@/shared/contracts/hue";
import { HUE_LEFT_OUT_REASON, LIGHTING_MODE_STATUS, type HueLeftOutReason } from "@/shared/contracts/lighting";
import {
  BOOT_HUE_RETRY_STATE,
  LIGHTING_ORIGIN,
  type ApplyOutputsRequest,
  type ApplyOutputsResult,
  type BootHueRetryState,
  type LightingOrigin,
} from "@/shared/contracts/lightingRuntime";
import {
  LIGHTING_MODE_KIND,
  normalizeAmbilightPayload,
  normalizeOutputTargets,
  normalizeSolidColorPayload,
  type AmbilightPayload,
  type LightingModeConfig,
  type SolidColorPayload,
} from "@/shared/contracts/mode";

import { getScreenCapturePermission } from "../captureApi";
import { applyOutputs, releaseHueOutput, retuneLighting } from "../modeApi";
import { isOutputsApplied, needsCalibration, pickStartFailureNotice, startFailureNotice } from "./modeApplyOutcome";
import { createRetuneCoalescer } from "./retuneCoalescer";
import { useLightingRuntime } from "./useLightingRuntime";

/** How long the "stop failed for these targets" toast stays up. */
const STOP_FAILED_NOTICE_MS = 5_000;

/** Longer than the stop toast: this one asks the user to go change a setting. */
const START_FAILED_NOTICE_MS = 8_000;

/** Same length as the start toast: the auth variant asks the user to re-pair. */
const HUE_LEFT_OUT_NOTICE_MS = 8_000;

/** Same length as the other notices that ask the user to act. */
export const BOOT_HUE_RETRY_GAVE_UP_NOTICE_MS = 8_000;

const OFF: LightingModeConfig = { kind: LIGHTING_MODE_KIND.OFF };

function isPermissionNotice(notice: CaptureFailureNotice | null): boolean {
  return notice?.bucket === CAPTURE_FAILURE_BUCKET.PERMISSION;
}

function withoutPermissionNotice(notice: CaptureFailureNotice | null): CaptureFailureNotice | null {
  return isPermissionNotice(notice) ? null : notice;
}

/** The saved mode the launch restores, read by bootstrap before it asks. */
export interface BootLightingInput {
  lightingMode?: LightingModeConfig;
}

export interface LightingModeOrchestratorInput {
  /** Calibration gate: a USB target with no calibration routes the user to the editor. */
  onRequireCalibration: () => void;
  reportHueSolidColorStatus: (code: string) => void;
}

export interface LightingModeOrchestrator {
  /** What runs, with the last colour and Ambilight settings kept through Off. */
  lightingMode: LightingModeConfig;
  selectedOutputTargets: HueRuntimeTarget[];
  activeOutputTargets: HueRuntimeTarget[];
  isModeTransitioning: boolean;
  stopFailedNotice: HueRuntimeTarget[] | null;
  startFailedNotice: CaptureFailureNotice | null;
  /** The permission came back: the permission notice, a condition, is no longer true. */
  clearCapturePermissionNotice: () => void;
  /** A `[usb, hue]` start ran on USB alone this session; the reason picks the copy. */
  hueLeftOutNotice: HueLeftOutReason | null;
  /**
   * Why Hue is out of the running mode, for the status chip. Raised with the
   * notice but not dismissed with it: it holds until Hue joins, or the user
   * makes a mode or output choice.
   */
  hueHeldOutReason: HueLeftOutReason | null;
  /** A boot restore is waiting for the bridge to free its area, or gave up waiting. */
  bootHueRetryNotice: BootHueRetryState | null;
  handleLightingModeChange: (mode: LightingModeConfig) => Promise<void>;
  /** A choice of outputs — the Lights toggles, pairing a strip, the unsupported-port fallback. */
  handleOutputTargetsChange: (targets: HueRuntimeTarget[]) => Promise<void>;
  /** The same change for a USB unplug, which never writes `lastOutputTargets`. */
  dropUnpluggedUsbTarget: (targets: HueRuntimeTarget[]) => Promise<void>;
  /**
   * An unplug of the strip that was the only selected target. Resolves `true`
   * when a running mode ended because of it, and so the UI now shows Off.
   */
  endLightingOnUsbUnplug: () => Promise<boolean>;
  /** A Hue stop from outside the mode controls: a running mode lets go of Hue first. */
  stopHueOutput: (triggerSource: HueRuntimeTriggerSource) => Promise<void>;
  /** The launch restore, once per boot. */
  restoreAtBoot: (saved: BootLightingInput) => Promise<void>;
  selectedOutputTargetsRef: RefObject<HueRuntimeTarget[]>;
}

/** The request's mode: the kind, and a payload only when the caller has one. */
function choiceOf(mode: LightingModeConfig): LightingModeConfig {
  return {
    kind: mode.kind,
    ...(mode.solid ? { solid: mode.solid } : {}),
    ...(mode.ambilight ? { ambilight: mode.ambilight } : {}),
  };
}

/**
 * The main window's half of the lighting transaction. Every choice goes to
 * Rust as one `apply_outputs` (or one `retune_lighting` for a nudge within the
 * running kind); what runs comes back as the runtime snapshot. What is left
 * here is what only this window shows: the notices, their timers, and the
 * screen-recording preflight. See docs/architecture/lighting-transaction.md.
 */
export function useLightingModeOrchestrator({
  onRequireCalibration,
  reportHueSolidColorStatus,
}: LightingModeOrchestratorInput): LightingModeOrchestrator {
  const { snapshot, adopt } = useLightingRuntime();
  // Surfaces the targets whose stop failed, so the chip stays active instead of
  // silently lying about state. Banner auto-dismisses; user can retry by toggling.
  const [stopFailedNotice, setStopFailedNotice] = useState<HueRuntimeTarget[] | null>(null);
  // Raised by a choice's reply and by the boot restore — which filters the
  // display bucket out, so a launch against an unplugged display must not toast.
  const [startFailedNotice, setStartFailedNotice] = useState<CaptureFailureNotice | null>(null);
  const [hueLeftOutNotice, setHueLeftOutNotice] = useState<HueLeftOutReason | null>(null);
  const [bootHueRetryNotice, setBootHueRetryNotice] = useState<BootHueRetryState | null>(null);
  const [pendingChoices, setPendingChoices] = useState(0);
  // The kind the newest choice asked for, while it is in flight: a nudge of
  // that kind is a retune the transaction applies when it lands, not a new choice.
  const requestedKindRef = useRef<LightingModeConfig["kind"] | null>(null);
  const choiceSeqRef = useRef(0);

  // The snapshot says what runs; Off carries no payload. The last colour and
  // Ambilight settings seen are kept so the controls show them while Off.
  const rememberedRef = useRef<{ solid?: SolidColorPayload; ambilight?: AmbilightPayload }>({});
  const running = snapshot?.mode ?? OFF;
  const lightingMode = useMemo<LightingModeConfig>(() => {
    if (running.solid) rememberedRef.current.solid = running.solid;
    if (running.ambilight) rememberedRef.current.ambilight = running.ambilight;
    return {
      ...running,
      solid: running.solid ?? rememberedRef.current.solid,
      ambilight: running.ambilight ?? rememberedRef.current.ambilight,
    };
  }, [running]);
  const lightingModeRef = useRef(lightingMode);
  lightingModeRef.current = lightingMode;

  const selectedOutputTargets = useMemo(() => snapshot?.selectedTargets ?? [], [snapshot?.selectedTargets]);
  const activeOutputTargets = useMemo(() => snapshot?.activeTargets ?? [], [snapshot?.activeTargets]);
  const selectedOutputTargetsRef = useRef<HueRuntimeTarget[]>(selectedOutputTargets);
  selectedOutputTargetsRef.current = selectedOutputTargets;

  const hueHeldOutReason = snapshot?.hueHeldOutReason ?? null;
  const bootHueRetry = snapshot?.bootHueRetry ?? null;

  const retunes = useMemo(() => createRetuneCoalescer((tuning) => retuneLighting(tuning)), []);

  // The notice follows the held-out reason: raised when it appears or
  // changes, taken down when Hue joins or a choice answers it afresh.
  useEffect(() => {
    setHueLeftOutNotice(hueHeldOutReason);
  }, [hueHeldOutReason]);

  useEffect(() => {
    setBootHueRetryNotice(bootHueRetry);
  }, [bootHueRetry]);

  // Same shape as the notice below: a tracked timer, cleared on unmount, so a
  // second failure never leaves two timers racing the same setter.
  useEffect(() => {
    if (!stopFailedNotice) return;
    const timerId = window.setTimeout(() => setStopFailedNotice(null), STOP_FAILED_NOTICE_MS);
    return () => window.clearTimeout(timerId);
  }, [stopFailedNotice]);

  const clearCapturePermissionNotice = useCallback(() => setStartFailedNotice(withoutPermissionNotice), []);

  useEffect(() => {
    // Permission is a condition, not an event: it clears when the permission
    // comes back or a start succeeds, never on a timer.
    if (!startFailedNotice || isPermissionNotice(startFailedNotice)) return;
    const timerId = window.setTimeout(() => setStartFailedNotice(null), START_FAILED_NOTICE_MS);
    return () => window.clearTimeout(timerId);
  }, [startFailedNotice]);

  useEffect(() => {
    // The busy notice describes a wait still under way; the retry replaces or clears it.
    if (!hueLeftOutNotice || hueLeftOutNotice === HUE_LEFT_OUT_REASON.BUSY) return;
    const timerId = window.setTimeout(() => setHueLeftOutNotice(null), HUE_LEFT_OUT_NOTICE_MS);
    return () => window.clearTimeout(timerId);
  }, [hueLeftOutNotice]);

  useEffect(() => {
    if (bootHueRetryNotice !== BOOT_HUE_RETRY_STATE.GAVE_UP) return;
    const timerId = window.setTimeout(() => setBootHueRetryNotice(null), BOOT_HUE_RETRY_GAVE_UP_NOTICE_MS);
    return () => window.clearTimeout(timerId);
  }, [bootHueRetryNotice]);

  /** Everything a reply can ask of this window. */
  const readReply = useCallback(
    (result: ApplyOutputsResult, options: { probeNotice?: CaptureFailureNotice | null; boot?: boolean } = {}) => {
      adopt(result.snapshot);
      if (needsCalibration(result)) {
        onRequireCalibration();
        return;
      }
      if (result.outcome.stopFailed.length > 0) setStopFailedNotice(result.outcome.stopFailed);

      const apply = result.outcome.applyStatus;
      if (apply?.code === LIGHTING_MODE_STATUS.SOLID_MODE_HUE_OUTPUT_SKIPPED) {
        reportHueSolidColorStatus(apply.details ?? HUE_SOLID_COLOR_STATUS.APPLY_SKIPPED);
      } else if (apply?.code === LIGHTING_MODE_STATUS.SOLID_MODE_APPLIED) {
        reportHueSolidColorStatus(HUE_SOLID_COLOR_STATUS.APPLIED);
      }

      const failure = startFailureNotice(result);
      if (failure) {
        if (!(options.boot && failure.bucket === CAPTURE_FAILURE_BUCKET.DISPLAY)) {
          setStartFailedNotice(pickStartFailureNotice(options.probeNotice ?? null, failure));
        }
        return;
      }
      // A start went through, so a permission notice — including the one the
      // advisory probe raised for this very start — no longer holds.
      if (isOutputsApplied(result) && result.snapshot.mode.kind !== LIGHTING_MODE_KIND.OFF) {
        setStartFailedNotice(withoutPermissionNotice);
      }
    },
    [adopt, onRequireCalibration, reportHueSolidColorStatus],
  );

  const send = useCallback(
    async (
      request: ApplyOutputsRequest,
      options: { probeNotice?: CaptureFailureNotice | null; boot?: boolean } = {},
    ): Promise<ApplyOutputsResult | null> => {
      try {
        const result = await applyOutputs(request);
        readReply(result, options);
        return result;
      } catch (error) {
        console.error(`[LumaSync] apply_outputs (${request.origin}) failed:`, error);
        return null;
      }
    },
    [readReply],
  );

  const handleLightingModeChange = useCallback(
    async (next: LightingModeConfig) => {
      const currentKind = requestedKindRef.current ?? lightingModeRef.current.kind;
      // A nudge within the running kind never waits for a transition, and a
      // drag commits many of them: they go through the coalescer as retunes.
      if (next.kind === currentKind && next.kind !== LIGHTING_MODE_KIND.OFF) {
        if (next.kind === LIGHTING_MODE_KIND.SOLID && next.solid) {
          retunes.push({ solid: normalizeSolidColorPayload(next.solid) });
        } else if (next.kind === LIGHTING_MODE_KIND.AMBILIGHT && next.ambilight) {
          retunes.push({ ambilight: normalizeAmbilightPayload(next.ambilight) });
        }
        return;
      }

      retunes.reset();
      const seq = ++choiceSeqRef.current;
      requestedKindRef.current = next.kind;
      setPendingChoices((n) => n + 1);
      try {
        let probeNotice: CaptureFailureNotice | null = null;
        // Advisory probe, never a gate: the OS prompt only appears from the
        // Rust start path below, so short-circuiting here would leave a
        // first-run user unable to ever grant the permission.
        if (next.kind === LIGHTING_MODE_KIND.AMBILIGHT) {
          try {
            const permission = await getScreenCapturePermission();
            if (isScreenCaptureBlocked(permission.code)) {
              probeNotice = describeCaptureFailure(AMBILIGHT_CAPTURE_REASON.PERMISSION_DENIED);
              setStartFailedNotice(probeNotice);
            }
          } catch (error) {
            console.error("[LumaSync] screen-recording preflight failed:", error);
          }
        }
        await send({ mode: choiceOf(next), origin: LIGHTING_ORIGIN.USER }, { probeNotice });
      } finally {
        if (choiceSeqRef.current === seq) requestedKindRef.current = null;
        setPendingChoices((n) => n - 1);
      }
    },
    [retunes, send],
  );

  const changeTargets = useCallback(
    async (targets: HueRuntimeTarget[], origin: LightingOrigin) =>
      send({ targets: normalizeOutputTargets(targets), origin }),
    [send],
  );

  const handleOutputTargetsChange = useCallback(
    async (targets: HueRuntimeTarget[]) => {
      await changeTargets(targets, LIGHTING_ORIGIN.USER);
    },
    [changeTargets],
  );

  // Session-only: a cable falling out is not the user choosing to stop using the strip.
  const dropUnpluggedUsbTarget = useCallback(
    async (targets: HueRuntimeTarget[]) => {
      await changeTargets(targets, LIGHTING_ORIGIN.USB_UNPLUG);
    },
    [changeTargets],
  );

  const endLightingOnUsbUnplug = useCallback(async () => {
    // Off already: nothing runs, and there is nothing to report.
    if (lightingModeRef.current.kind === LIGHTING_MODE_KIND.OFF) return false;
    const result = await send({ targets: [], origin: LIGHTING_ORIGIN.USB_UNPLUG });
    return result?.outcome.modeEnded ?? false;
  }, [send]);

  // The Devices card's Stop retrying and Retry stop. A second press while the
  // first is in flight joins it.
  const hueReleaseRef = useRef<Promise<void> | null>(null);
  const stopHueOutput = useCallback(
    (triggerSource: HueRuntimeTriggerSource) => {
      if (hueReleaseRef.current !== null) return hueReleaseRef.current;
      const release = (async () => {
        try {
          readReply(await releaseHueOutput(triggerSource));
        } catch (error) {
          console.error("[LumaSync] Hue stop from the Devices card failed:", error);
        } finally {
          hueReleaseRef.current = null;
        }
      })();
      hueReleaseRef.current = release;
      return release;
    },
    [readReply],
  );

  const restoreAtBoot = useCallback(
    async (saved: BootLightingInput) => {
      // Off carries no payload in the snapshot; the saved mode has both.
      if (saved.lightingMode?.solid) rememberedRef.current.solid = saved.lightingMode.solid;
      if (saved.lightingMode?.ambilight) rememberedRef.current.ambilight = saved.lightingMode.ambilight;
      await send({ origin: LIGHTING_ORIGIN.BOOT }, { boot: true });
    },
    [send],
  );

  return {
    lightingMode,
    selectedOutputTargets,
    activeOutputTargets,
    // This window's own choices only. The snapshot's phase also moves for a
    // settings refresh, and disabling the sliders for one would drop a drag.
    isModeTransitioning: pendingChoices > 0,
    stopFailedNotice,
    startFailedNotice,
    clearCapturePermissionNotice,
    hueLeftOutNotice,
    hueHeldOutReason,
    bootHueRetryNotice,
    handleLightingModeChange,
    handleOutputTargetsChange,
    dropUnpluggedUsbTarget,
    endLightingOnUsbUnplug,
    stopHueOutput,
    restoreAtBoot,
    selectedOutputTargetsRef,
  };
}
