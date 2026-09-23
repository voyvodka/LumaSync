import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import type { HueStartConfig } from "@/features/hue/model/hueStartConfig";
import { isHueStartCodeOk, isHueStopCodeOk, toHueStartConfig } from "@/features/hue/model/hueStartConfig";
import { loadShellState, saveShellState } from "@/features/shell/windowLifecycle";
import { createLatestOperationGuard } from "@/shared/lib/latestOperation";
import {
  AMBILIGHT_CAPTURE_REASON,
  describeCaptureFailure,
  isScreenCaptureBlocked,
  type CaptureFailureNotice,
} from "@/shared/contracts/capture";
import { HUE_RUNTIME_TRIGGER_SOURCE, type HueRuntimeTarget } from "@/shared/contracts/hue";
import { HUE_LEFT_OUT_REASON, LIGHTING_MODE_GATE_STATUS, type HueLeftOutReason } from "@/shared/contracts/lighting";

import { getScreenCapturePermission } from "../captureApi";
import { setHueSolidColor, startHue, stopHue, stopLighting, type ModeCommandResult } from "../modeApi";
import {
  DEFAULT_OUTPUT_TARGETS,
  LIGHTING_MODE_KIND,
  normalizeLightingModeConfig,
  normalizeOutputTargets,
  type LightingModeConfig,
  type SolidColorPayload,
} from "../model/contracts";
import {
  applyRuntimeResultToTargets,
  resolveHueRuntimePlan,
  type HueTargetCommandResult,
} from "./hueModeRuntimeFlow";
import {
  hueLeftOutReason,
  hueLeftOutRetryTargets,
  pickStartFailureNotice,
  readModeApplyOutcome,
  shouldCancelHueAfterLeavingOut,
  shouldReleaseHueAfterRefusal,
  usbStartRefusalNotice,
} from "./modeApplyOutcome";
import { useBootHueRetry, type BootHueRetryNotice, type BootHueRetryPlan } from "./bootHueRetry";
import { useLightingModeDispatch, type LightingModeDispatcher } from "./useLightingModeDispatch";
import { useLightingModePersistence } from "./useLightingModePersistence";
import type { ModeRuntimeConfig } from "./useModeRuntimeConfig";

/** How long the "stop failed for these targets" toast stays up. */
const STOP_FAILED_NOTICE_MS = 5_000;

/** Longer than the stop toast: this one asks the user to go change a setting. */
const START_FAILED_NOTICE_MS = 8_000;

/** Same length as the start toast: the auth variant asks the user to re-pair. */
const HUE_LEFT_OUT_NOTICE_MS = 8_000;

export interface LightingModeOrchestratorInput {
  runtimeConfig: ModeRuntimeConfig;
  savedCalibration: LedCalibrationConfig | undefined;
  hueStartConfig: HueStartConfig | null;
  setHueStartConfig: (config: HueStartConfig | null) => void;
  /** D-05 gate: a USB target with no calibration routes the user to the editor. */
  onRequireCalibration: () => void;
  reportHueSolidColorStatus: (code: string) => void;
}

export interface LightingModeOrchestrator {
  lightingMode: LightingModeConfig;
  selectedOutputTargets: HueRuntimeTarget[];
  activeOutputTargets: HueRuntimeTarget[];
  isModeTransitioning: boolean;
  stopFailedNotice: HueRuntimeTarget[] | null;
  startFailedNotice: CaptureFailureNotice | null;
  /** Lets the boot restore raise the same toast the interactive start does. */
  reportStartFailure: (notice: CaptureFailureNotice) => void;
  /** A `[usb, hue]` start ran on USB alone this session; the reason picks the copy. */
  hueLeftOutNotice: HueLeftOutReason | null;
  /** The boot restore's route to the same notice. */
  reportHueLeftOut: (reason: HueLeftOutReason) => void;
  /** A boot restore is waiting for the bridge to free its area, or gave up waiting. */
  bootHueRetryNotice: BootHueRetryNotice | null;
  /** Boot only: resume a restore, or add Hue back to one, that a held area refused. */
  scheduleBootHueRetry: (plan: BootHueRetryPlan, config: HueStartConfig) => void;
  handleLightingModeChange: (mode: LightingModeConfig) => Promise<void>;
  handleOutputTargetsChange: (targets: HueRuntimeTarget[]) => Promise<void>;
  /** Hot-reload props push a config nudge without going through a transition. */
  dispatch: LightingModeDispatcher;
  /** Bootstrap and the Hue solid sync write the mode without a transition. */
  setLightingMode: (mode: LightingModeConfig) => void;
  adoptSolidColor: (solid: SolidColorPayload) => void;
  /** Direct target writes: bootstrap restore and the two USB reconciler paths. */
  setSelectedOutputTargets: (targets: HueRuntimeTarget[]) => void;
  setActiveOutputTargets: React.Dispatch<React.SetStateAction<HueRuntimeTarget[]>>;
  lightingModeRef: RefObject<LightingModeConfig>;
  lastNonOffModeRef: RefObject<LightingModeConfig | null>;
  selectedOutputTargetsRef: RefObject<HueRuntimeTarget[]>;
  activeOutputTargetsRef: RefObject<HueRuntimeTarget[]>;
  dispatchRef: RefObject<LightingModeDispatcher | null>;
}

/**
 * The mode transaction. Owns the four multi-writer slices and both handlers,
 * because the slow path's three phases share a mutable result map and the
 * ordering between them is the contract, not an implementation detail.
 */
export function useLightingModeOrchestrator({
  runtimeConfig,
  savedCalibration,
  hueStartConfig,
  setHueStartConfig,
  onRequireCalibration: handleOpenCalibration,
  reportHueSolidColorStatus,
}: LightingModeOrchestratorInput): LightingModeOrchestrator {
  const [lightingMode, setLightingModeState] = useState<LightingModeConfig>({ kind: LIGHTING_MODE_KIND.OFF });
  const [selectedOutputTargets, setSelectedOutputTargets] = useState<HueRuntimeTarget[]>([...DEFAULT_OUTPUT_TARGETS]);
  const [activeOutputTargets, setActiveOutputTargets] = useState<HueRuntimeTarget[]>([]);
  const outputTargetsGuardRef = useRef(createLatestOperationGuard());
  const [isModeTransitioning, setIsModeTransitioning] = useState(false);
  // A1.2 — surfaces the targets whose stop_lighting / stop_hue_stream invoke
  // failed during a delta-stop, so the chip stays active instead of silently
  // lying about state. Banner auto-dismisses; user can retry by toggling.
  const [stopFailedNotice, setStopFailedNotice] = useState<HueRuntimeTarget[] | null>(null);
  // Raised by the slow path below and, through `reportStartFailure`, by the boot
  // restore — which filters the display bucket out, so a launch against an
  // unplugged display must not toast.
  const [startFailedNotice, setStartFailedNotice] = useState<CaptureFailureNotice | null>(null);
  // Unlike the start notice, the boot restore raises this one for every reason:
  // the display-bucket filter is about capture, and this says what is running.
  const [hueLeftOutNotice, setHueLeftOutNotice] = useState<HueLeftOutReason | null>(null);

  const modeTransitionLockRef = useRef(false);
  const pendingModeChangeRef = useRef<LightingModeConfig | null>(null);
  const activeOutputTargetsRef = useRef<HueRuntimeTarget[]>([]);
  // Tray quick-action refs — always hold latest values for use in stable listeners
  const lightingModeRef = useRef<LightingModeConfig>(lightingMode);
  const lastNonOffModeRef = useRef<LightingModeConfig | null>(null);
  const selectedOutputTargetsRef = useRef<HueRuntimeTarget[]>(selectedOutputTargets);

  const hydrateModePayload = runtimeConfig.hydrate;
  const {
    dispatch: dispatchSetLightingMode,
    resetSignature: resetLightingModeSignature,
    dispatchRef,
  } = useLightingModeDispatch(hydrateModePayload);
  const scheduleLightingModePersist = useLightingModePersistence();

  useEffect(() => {
    activeOutputTargetsRef.current = activeOutputTargets;
  }, [activeOutputTargets]);

  // Keep tray refs in sync with latest state
  useEffect(() => { lightingModeRef.current = lightingMode; }, [lightingMode]);
  useEffect(() => { selectedOutputTargetsRef.current = selectedOutputTargets; }, [selectedOutputTargets]);
  // v1.5 H1 — keep the cached ambilight payload aligned with the live
  // payload so subsequent dispatches (after the bootstrap prime) read
  // the user's most recent slider commits, not stale post-bootstrap data.
  useEffect(() => { runtimeConfig.setAmbilight(lightingMode.ambilight); }, [runtimeConfig, lightingMode.ambilight]);
  useEffect(() => {
    if (lightingMode.kind !== LIGHTING_MODE_KIND.OFF) {
      lastNonOffModeRef.current = lightingMode;
    }
  }, [lightingMode]);

  const handleLightingModeChangeRef = useRef<((mode: LightingModeConfig) => Promise<void>) | null>(null);
  const applyOutputTargetsRef = useRef<((targets: HueRuntimeTarget[], persist: boolean) => Promise<void>) | null>(null);
  const resumeAfterBootHueRetry = useCallback(async (mode: LightingModeConfig) => {
    // Anything that started a mode meanwhile has already had its say.
    if (lightingModeRef.current.kind !== LIGHTING_MODE_KIND.OFF) return;
    await handleLightingModeChangeRef.current?.({
      kind: mode.kind,
      ambilight: mode.ambilight,
      solid: mode.solid,
    });
  }, []);
  // No guard of its own: every mode or output choice cancels the wait first,
  // and the delta path already starts nothing while Off.
  const rejoinAfterBootHueRetry = useCallback(async () => {
    // Not persisted: `lastOutputTargets` never lost Hue, since the drop was session-only.
    await applyOutputTargetsRef.current?.([...selectedOutputTargetsRef.current, "hue"], false);
  }, []);
  const bootHueRetry = useBootHueRetry({
    resume: resumeAfterBootHueRetry,
    rejoin: rejoinAfterBootHueRetry,
    setHueLeftOut: setHueLeftOutNotice,
  });
  const cancelBootHueRetry = bootHueRetry.cancel;
  const isBootHueRejoinPending = bootHueRetry.isRejoinPending;

  // The delta path the user's own output toggle takes. The boot rejoin enters
  // here directly: the same dispatch, without persisting or cancelling itself.
  const applyOutputTargets = useCallback(async (targets: HueRuntimeTarget[], persist: boolean) => {
    // The toggles stay live while this runs, so a user can remove Hue before
    // the add that started first has finished. Without the guard that add
    // lands afterwards and puts Hue back into the active set.
    const isLatest = outputTargetsGuardRef.current.begin();
    const normalizedTargets = normalizeOutputTargets(targets);
    const prevTargets = selectedOutputTargets;
    setSelectedOutputTargets(normalizedTargets);
    if (persist) {
      try {
        await saveShellState({ lastOutputTargets: normalizedTargets });
      } catch (err) {
        console.error("[LumaSync] saveShellState(lastOutputTargets) failed:", err);
      }
    }

    // Delta logic — only when a mode is actively running (not OFF)
    if (lightingMode.kind === LIGHTING_MODE_KIND.OFF) return;

    const currentActive = activeOutputTargetsRef.current;
    const addedTargets = normalizedTargets.filter((t) => !prevTargets.includes(t));
    const removedTargets = prevTargets.filter((t) => !normalizedTargets.includes(t));

    // Per-target outcome, not `Promise.all`: only a target that actually stopped
    // leaves active membership. Dropping one from the UI while its backend stream
    // lived on is what produced HUE_STREAM_NOT_READY_ACTIVE_STREAMER next start.
    type StopOutcome = { target: HueRuntimeTarget; ok: boolean };
    const stopResults = await Promise.allSettled(
      removedTargets.map(async (target): Promise<StopOutcome> => {
        if (!currentActive.includes(target)) return { target, ok: true };
        if (target !== "usb" && target !== "hue") return { target, ok: true };
        try {
          if (target === "usb") {
            await stopLighting();
          } else {
            // System-attributed, not MODE_CONTROL default — this stop is a side
            // effect of the target-set change, not a direct user mode toggle.
            await stopHue(HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM);
          }
          return { target, ok: true };
        } catch (err) {
          console.error(
            `[LumaSync] stop failed for target=${target}, retaining in activeOutputTargets:`,
            err,
          );
          return { target, ok: false };
        }
      })
    );
    const successfullyStopped = stopResults
      .filter((r): r is PromiseFulfilledResult<StopOutcome> => r.status === "fulfilled" && r.value.ok)
      .map((r) => r.value.target);
    const failedToStop = stopResults
      .filter((r): r is PromiseFulfilledResult<StopOutcome> => r.status === "fulfilled" && !r.value.ok)
      .map((r) => r.value.target);
    if (!isLatest()) return;

    if (successfullyStopped.length > 0) {
      const nextActive = currentActive.filter((t) => !successfullyStopped.includes(t));
      setActiveOutputTargets(nextActive);
    }
    if (failedToStop.length > 0) {
      setStopFailedNotice(failedToStop);
    }

    // What outputs once the stops above settle. The left-out notice says
    // "running on USB only", which is only true while USB is live.
    let liveTargets = successfullyStopped.length > 0
      ? currentActive.filter((t) => !successfullyStopped.includes(t))
      : currentActive;
    // The targets each delta-start re-apply asks for; a refused USB add leaves it.
    let requestTargets = normalizedTargets;

    // Delta-start: for each added target, start the current mode on it.
    // D-06: a target that fails to start never disturbs the ones already running.
    for (const target of addedTargets) {
      // Re-checked per target, not once: each iteration awaits, so a newer
      // change can supersede this run partway through the list.
      if (!isLatest()) return;
      if (target === "usb") {
        let applyResult: ModeCommandResult | null = null;
        try {
          applyResult = await dispatchSetLightingMode({
            kind: lightingMode.kind,
            solid: lightingMode.solid,
            ambilight: lightingMode.ambilight,
            targets: requestTargets,
          }, { force: true });
        } catch (err) {
          console.error("[LumaSync] USB delta-start dispatch failed; the running targets continue:", err);
        }
        if (!isLatest()) return;

        // Read as the Hue add below reads it: a gate refusal (DEVICE_NOT_CONNECTED)
        // echoes the running mode, which has the same kind. Absent or empty
        // targets mean USB-required to the backend (legacy D-10).
        const outcome = readModeApplyOutcome(applyResult, lightingMode.kind);
        const runningTargets = applyResult?.mode.targets;
        const usbDriven =
          applyResult !== null &&
          !outcome.refused &&
          (runningTargets === undefined || runningTargets.length === 0 || runningTargets.includes("usb"));

        if (usbDriven) {
          setActiveOutputTargets((prev) => [...new Set([...prev, "usb" as HueRuntimeTarget])]);
          liveTargets = [...new Set([...liveTargets, "usb" as HueRuntimeTarget])];
          continue;
        }

        // A later Hue add in this same change must not re-trip the USB gate.
        requestTargets = requestTargets.filter((t) => t !== "usb");
        const notice = applyResult === null ? null : usbStartRefusalNotice(applyResult);

        if (applyResult !== null && outcome.refused && applyResult.mode.kind === LIGHTING_MODE_KIND.OFF) {
          // The backend tore the running mode down before the start failed, so
          // nothing outputs. The teardown leaves the Hue stream open with nothing
          // feeding it, and the bridge admits one streamer — give back the one
          // this session held, as the slow path does. UI only: the persisted
          // mode stays for the next launch.
          console.error(
            `[LumaSync] USB delta-start re-apply stopped the running mode (${applyResult.status.code}).`,
          );
          let hueStillHeld = false;
          if (liveTargets.includes("hue")) {
            try {
              const stopResult = await stopHue(HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM);
              hueStillHeld = !isHueStopCodeOk(stopResult.status.code);
            } catch (err) {
              hueStillHeld = true;
              console.error("[LumaSync] Hue release after the USB delta-start stopped the mode failed:", err);
            }
            if (hueStillHeld) setStopFailedNotice(["hue"]);
          }
          if (!isLatest()) return;
          setActiveOutputTargets(hueStillHeld ? ["hue"] : []);
          setLightingModeState({ ...lightingMode, kind: LIGHTING_MODE_KIND.OFF });
          if (notice) setStartFailedNotice(notice);
          return;
        }

        // D-06: the gate returns before teardown, so the running targets are
        // untouched. Session-only, as for a left-out Hue: `lastOutputTargets`
        // keeps the explicit add saved above, so the next launch retries USB.
        console.error(
          `[LumaSync] USB delta-start was not applied (${applyResult?.status.code ?? "dispatch threw"}); the running targets continue.`,
        );
        setSelectedOutputTargets((prev) => prev.filter((t) => t !== "usb"));
        if (notice) setStartFailedNotice(notice);
      }
      if (target === "hue") {
        let runtimeHueConfig = hueStartConfig;
        try {
          runtimeHueConfig = toHueStartConfig(await loadShellState()) ?? hueStartConfig;
        } catch (err) {
          console.error("[LumaSync] Hue delta-start could not read the shell state; using the cached config:", err);
        }
        if (!isLatest()) return;

        let hueStartCode: string | undefined;
        if (runtimeHueConfig) {
          try {
            hueStartCode = (await startHue(runtimeHueConfig)).status.code;
          } catch (err) {
            console.error("[LumaSync] Hue delta-start failed:", err);
          }
          if (!isLatest()) return;
        }

        // Re-apply so the running worker picks up the now-live Hue stream
        // context; without it the worker has hue_output=None and never sends
        // colours to Hue. A failed start is not dispatched: with no stream
        // context the Rust Hue gate would refuse it anyway.
        let applyResult: ModeCommandResult | null = null;
        if (hueStartCode !== undefined && isHueStartCodeOk(hueStartCode)) {
          try {
            applyResult = await dispatchSetLightingMode({
              kind: lightingMode.kind,
              solid: lightingMode.solid,
              ambilight: lightingMode.ambilight,
              targets: requestTargets,
            }, { force: true });
          } catch (err) {
            console.error("[LumaSync] Hue delta-start mode dispatch failed:", err);
          }
          if (!isLatest()) return;
        }

        // `mode` reports what the backend runs, so Hue counts as added only once
        // it is in the running targets. A gate refusal reports the previous mode,
        // which has the same kind — `refused` alone would read it as accepted.
        const outcome = readModeApplyOutcome(applyResult, lightingMode.kind);
        const hueDriven =
          applyResult !== null && !outcome.refused && (applyResult.mode.targets ?? []).includes("hue");

        if (hueDriven) {
          setActiveOutputTargets((prev) => [...new Set([...prev, "hue" as HueRuntimeTarget])]);
          liveTargets = [...new Set([...liveTargets, "hue" as HueRuntimeTarget])];
          if (lightingMode.kind === LIGHTING_MODE_KIND.SOLID && lightingMode.solid) {
            try {
              const colorResult = await setHueSolidColor({
                r: lightingMode.solid.r,
                g: lightingMode.solid.g,
                b: lightingMode.solid.b,
                brightness: lightingMode.solid.brightness,
              });
              reportHueSolidColorStatus(colorResult.status.code);
            } catch (err) {
              console.error("[LumaSync] Hue solid push on delta-start non-fatal failure:", err);
            }
          }
          continue;
        }

        // Left out — settled as the slow path settles a [usb, hue] start the gate
        // refuses. A stream or retry this session owns is cancelled, or the
        // health poll re-adds "hue" behind the notice's back.
        const hueActiveBefore = currentActive.includes("hue");
        const cancelHue = shouldCancelHueAfterLeavingOut({ hueStartCode, hueActiveBefore });
        let hueStillHeld = false;
        if (cancelHue) {
          try {
            const stopResult = await stopHue(HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM);
            hueStillHeld = !isHueStopCodeOk(stopResult.status.code);
          } catch (err) {
            hueStillHeld = true;
            console.error("[LumaSync] Hue cancel after leaving it out of the delta-start failed:", err);
          }
          if (hueStillHeld) setStopFailedNotice(["hue"]);
        }
        if (!isLatest()) return;

        if (applyResult !== null && outcome.refused && applyResult.mode.kind === LIGHTING_MODE_KIND.OFF) {
          // The backend tore the running mode down before the restart failed, so
          // nothing outputs and "running on USB only" would be false. UI only, as
          // in the slow path: the persisted mode stays for the next launch.
          console.error(
            `[LumaSync] Hue delta-start re-apply stopped the running mode (${applyResult.status.code}).`,
          );
          setActiveOutputTargets(hueStillHeld ? ["hue"] : []);
          setLightingModeState({ ...lightingMode, kind: LIGHTING_MODE_KIND.OFF });
          if (outcome.startFailure) setStartFailedNotice(outcome.startFailure);
          return;
        }

        if (cancelHue) {
          // A stream that would not stop stays listed, as in the slow path.
          setActiveOutputTargets((prev) =>
            hueStillHeld
              ? [...new Set([...prev, "hue" as HueRuntimeTarget])]
              : prev.filter((t) => t !== "hue"),
          );
        }
        // Session-only, as in the slow path. `lastOutputTargets` was saved above
        // with the user's explicit add and keeps it, so the next launch retries Hue.
        setSelectedOutputTargets((prev) => prev.filter((t) => t !== "hue"));

        // The Hue gate returns before teardown, so the previous targets keep running.
        const hueWasTheReason =
          hueStartCode === undefined ||
          !isHueStartCodeOk(hueStartCode) ||
          hueLeftOutRetryTargets(applyResult, requestTargets) !== null;
        if (hueWasTheReason && liveTargets.includes("usb")) {
          setHueLeftOutNotice(hueLeftOutReason(runtimeHueConfig !== null, hueStartCode));
        } else {
          console.error(
            `[LumaSync] Hue delta-start left Hue out (start ${hueStartCode ?? "none"}, apply ${applyResult?.status.code ?? "none"}).`,
          );
        }
      }
    }
  }, [lightingMode, selectedOutputTargets, hueStartConfig, hydrateModePayload, dispatchSetLightingMode, reportHueSolidColorStatus]);

  useEffect(() => {
    applyOutputTargetsRef.current = applyOutputTargets;
  }, [applyOutputTargets]);

  const handleOutputTargetsChange = useCallback(
    (targets: HueRuntimeTarget[]) => {
      const normalizedTargets = normalizeOutputTargets(targets);
      if (!normalizedTargets.includes("hue")) {
        cancelBootHueRetry("Hue was deselected");
      } else if (isBootHueRejoinPending()) {
        // The user turned Hue on themselves; their add answers for itself.
        cancelBootHueRetry("the output targets changed");
      }
      return applyOutputTargets(normalizedTargets, true);
    },
    [applyOutputTargets, cancelBootHueRetry, isBootHueRejoinPending],
  );


  // Same shape as the notice above. The dismissal used to be an untracked
  // `window.setTimeout` inside the delta-stop path, so nothing cleared it on
  // unmount and a second failure left two timers racing the same setter.
  useEffect(() => {
    if (!stopFailedNotice) return;
    const timerId = window.setTimeout(() => setStopFailedNotice(null), STOP_FAILED_NOTICE_MS);
    return () => window.clearTimeout(timerId);
  }, [stopFailedNotice]);

  useEffect(() => {
    if (!startFailedNotice) return;
    const timerId = window.setTimeout(() => setStartFailedNotice(null), START_FAILED_NOTICE_MS);
    return () => window.clearTimeout(timerId);
  }, [startFailedNotice]);

  useEffect(() => {
    // The busy notice describes a wait still under way; the retry replaces or clears it.
    if (!hueLeftOutNotice || hueLeftOutNotice === HUE_LEFT_OUT_REASON.BUSY) return;
    const timerId = window.setTimeout(() => setHueLeftOutNotice(null), HUE_LEFT_OUT_NOTICE_MS);
    return () => window.clearTimeout(timerId);
  }, [hueLeftOutNotice]);

  const handleLightingModeChange = useCallback(
    async (nextMode: LightingModeConfig) => {
      const normalizedNextMode = normalizeLightingModeConfig({
        kind: nextMode.kind,
        solid: nextMode.solid ?? lightingMode.solid,
        ambilight: nextMode.ambilight ?? lightingMode.ambilight,
        targets: selectedOutputTargets,
      });

      // Deliberately NOT gated on `isSameTargetSet(selected, active)` — see
      // docs/architecture/ui-and-shell.md. Reconciling targets here breaks drags.
      const isQuickSolidAdjustment =
        normalizedNextMode.kind === LIGHTING_MODE_KIND.SOLID &&
        lightingMode.kind === LIGHTING_MODE_KIND.SOLID;
      const isQuickAmbilightAdjustment =
        normalizedNextMode.kind === LIGHTING_MODE_KIND.AMBILIGHT &&
        lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT;
      const isQuickAdjustment = isQuickSolidAdjustment || isQuickAmbilightAdjustment;
      // Any mode choice, the retry's own included, supersedes a pending boot
      // retry. A slider tweak is not a choice: a rejoin adds Hue to the tweaked mode.
      if (!isQuickAdjustment) cancelBootHueRetry("the lighting mode changed");

      // fix #45 — quick adjustments dispatch unconditionally; the lock-gate is
      // strictly for kind-changing transitions. Queueing them behind it wedged
      // `isModeTransitioning` true. See docs/architecture/ui-and-shell.md.
      if (!isQuickAdjustment && modeTransitionLockRef.current) {
        pendingModeChangeRef.current = nextMode;
        return;
      }

      // Every path routes through `dispatchSetLightingMode` so its dedup ref stays
      // the single source of truth — hot-reload and delta-start re-applies too.

      if (isQuickSolidAdjustment && normalizedNextMode.solid) {
        setLightingModeState(normalizedNextMode);
        scheduleLightingModePersist(normalizedNextMode);

        if (activeOutputTargets.includes("usb")) {
          void dispatchSetLightingMode(normalizedNextMode).catch((error) => {
            console.error("[LumaSync] Failed to push USB solid update:", error);
          });
        }

        // Gated on the *selected* target: "hue" can be out of
        // `activeOutputTargets` while the user still wants Hue output, and the
        // backend queues the colour rather than dropping it.
        if (selectedOutputTargets.includes("hue") || activeOutputTargets.includes("hue")) {
          void setHueSolidColor({
            r: normalizedNextMode.solid.r,
            g: normalizedNextMode.solid.g,
            b: normalizedNextMode.solid.b,
            brightness: normalizedNextMode.solid.brightness,
          })
            .then((result) => {
              reportHueSolidColorStatus(result.status.code);
            })
            .catch((error) => {
              console.error("[LumaSync] Failed to push Hue solid update:", error);
            });
        }
        return;
      }

      // Rust updates live atomics in place for this case (AMBILIGHT_MODE_UPDATED),
      // leaving the worker and SCStream alone. Same drag reasoning as the solid
      // quick path above: a pending target reconcile must not promote it.
      if (isQuickAmbilightAdjustment) {
        setLightingModeState(normalizedNextMode);
        scheduleLightingModePersist(normalizedNextMode);
        void dispatchSetLightingMode(normalizedNextMode).catch((error) => {
          console.error("[LumaSync] Failed to push Ambilight settings update:", error);
        });
        return;
      }

      // Slow path: real mode-kind transition. Take the lock + flip the
      // transitioning flag so the dock surfaces a "switching outputs"
      // affordance instead of accepting a second click mid-flight.
      modeTransitionLockRef.current = true;
      // Reset the dedupe signature: a kind transition changes the payload
      // shape so the next quick adjustment after this completes must
      // always reach the backend.
      resetLightingModeSignature();
      setIsModeTransitioning(true);

      // D-05: USB target requires calibration; Hue-only does not
      const usesUsb = selectedOutputTargets.includes("usb");
      const requiresCalibration =
        usesUsb && !savedCalibration && normalizedNextMode.kind !== LIGHTING_MODE_KIND.OFF;

      if (requiresCalibration) {
        handleOpenCalibration();
        modeTransitionLockRef.current = false;
        setIsModeTransitioning(false);
        return;
      }

      try {
        const latestShellState = await loadShellState();
        const runtimeHueStartConfig = toHueStartConfig(latestShellState) ?? hueStartConfig;
        setHueStartConfig(runtimeHueStartConfig);

        if (normalizedNextMode.kind === LIGHTING_MODE_KIND.OFF) {
          const runtimePlan = resolveHueRuntimePlan({
            action: "stop",
            selectedTargets: selectedOutputTargets,
            activeTargets: activeOutputTargets,
            userInitiated: true,
            reconnectingTargets: activeOutputTargets,
          });

          const targetResults: Partial<Record<HueRuntimeTarget, HueTargetCommandResult>> = {};
          // `allSettled` for the same reason as the delta-stop path above: one
          // rejection under `Promise.all` discards the other target's outcome and
          // aborts before the results are applied.
          await Promise.allSettled(
            runtimePlan.stopTargets.map(async (target) => {
              if (target === "usb") {
                try {
                  await stopLighting();
                  targetResults.usb = { ok: true };
                } catch (error) {
                  const reason = error instanceof Error ? error.message : String(error);
                  targetResults.usb = { ok: false, code: "USB_STOP_FAILED", message: reason };
                }
              }
              if (target === "hue") {
                try {
                  const hueResult = await stopHue();
                  targetResults.hue = {
                    ok: isHueStopCodeOk(hueResult.status.code),
                    code: hueResult.status.code,
                    message: hueResult.status.message,
                  };
                } catch (error) {
                  const reason = error instanceof Error ? error.message : String(error);
                  targetResults.hue = { ok: false, code: "HUE_STOP_FAILED", message: reason };
                }
              }
            })
          );

          const shouldForceHueStop =
            !targetResults.hue &&
            (activeOutputTargets.includes("hue") ||
              selectedOutputTargets.includes("hue") ||
              Boolean(runtimeHueStartConfig));

          if (shouldForceHueStop) {
            try {
              const hueResult = await stopHue();
              targetResults.hue = {
                ok: isHueStopCodeOk(hueResult.status.code),
                code: hueResult.status.code,
                message: hueResult.status.message,
              };
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              targetResults.hue = { ok: false, code: "HUE_STOP_FAILED", message: reason };
            }
          }

          const merged = applyRuntimeResultToTargets(runtimePlan, targetResults);
          setActiveOutputTargets(merged.activeTargets);
          setLightingModeState(normalizedNextMode);
          scheduleLightingModePersist(normalizedNextMode);
          return;
        }

        const runtimePlan = resolveHueRuntimePlan({
          action: "start",
          selectedTargets: selectedOutputTargets,
          activeTargets: activeOutputTargets,
        });

        const targetResults: Partial<Record<HueRuntimeTarget, HueTargetCommandResult>> = {};

        // Phase 1 must precede Phase 2: `snapshot_hue_output_context()` needs a
        // live stream to hand the worker, or it comes up with `hue_output=None`.
        if (runtimePlan.startTargets.includes("hue")) {
          if (!runtimeHueStartConfig) {
            targetResults.hue = {
              ok: false,
              code: "CONFIG_NOT_READY_GATE_BLOCKED",
              message: "Hue start requires bridge, credential, and area configuration.",
            };
          } else {
            try {
              const hueResult = await startHue(runtimeHueStartConfig);
              targetResults.hue = {
                ok: isHueStartCodeOk(hueResult.status.code),
                code: hueResult.status.code,
                message: hueResult.status.message,
              };
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              targetResults.hue = { ok: false, code: "HUE_MODE_APPLY_FAILED", message: reason };
            }
          }
        }

        // Phase 2 — this is what starts the ambilight worker, so it must run for
        // Hue-only targets too or the stream comes up with no colour driver.
        const hueStartedOk = targetResults.hue?.ok === true;
        const hueStartCode = targetResults.hue?.code;
        // A failed Hue start still attempts the apply, but a gated start leaves
        // no stream context and nothing retrying it: the backend's Hue gate
        // refuses (HUE_NOT_READY) and the commit below keeps the UI off — unless
        // USB was requested too, in which case the apply is retried without Hue.
        const hueTransientFail =
          !hueStartedOk &&
          normalizedNextMode.kind === LIGHTING_MODE_KIND.AMBILIGHT &&
          runtimePlan.startTargets.includes("hue");
        const needsLightingModeApply =
          runtimePlan.startTargets.includes("usb") ||
          (runtimePlan.startTargets.includes("hue") && hueStartedOk) ||
          hueTransientFail;

        // Set by Phase 2 when the backend reports it is not running the requested
        // mode, so Phase 3's commit below can refuse to record a mode that never ran.
        let applyRefused = false;
        // What the backend is running after a refusal. A thrown apply reports
        // nothing, so the previous mode is assumed to still be live.
        let runningAfterRefusal: Pick<LightingModeConfig, "kind" | "targets"> = {
          kind: lightingMode.kind,
          targets: activeOutputTargets,
        };
        // Set when the Hue gate refused a [usb, hue] start and the retry ran
        // without Hue. Session-only: `lastOutputTargets` is never rewritten.
        let usbOnlyTargets: HueRuntimeTarget[] | null = null;
        let hueReleased = false;
        let hueReleaseFailed = false;

        if (needsLightingModeApply) {
          let probeNotice: CaptureFailureNotice | null = null;
          // Advisory probe, never a gate: the OS prompt only appears from the
          // Rust start path below, so short-circuiting here would leave a
          // first-run user unable to ever grant the permission.
          if (normalizedNextMode.kind === LIGHTING_MODE_KIND.AMBILIGHT) {
            const permission = await getScreenCapturePermission();
            if (isScreenCaptureBlocked(permission.code)) {
              probeNotice = describeCaptureFailure(AMBILIGHT_CAPTURE_REASON.PERMISSION_DENIED);
              setStartFailedNotice(probeNotice);
            }
          }
          try {
            let applyResult = await dispatchSetLightingMode(normalizedNextMode, { force: true });
            usbOnlyTargets = hueLeftOutRetryTargets(applyResult, normalizedNextMode.targets ?? []);
            if (usbOnlyTargets !== null) {
              targetResults.hue = {
                ok: false,
                code: LIGHTING_MODE_GATE_STATUS.HUE_NOT_READY,
                message: applyResult?.status.message,
              };
              if (
                shouldCancelHueAfterLeavingOut({
                  hueStartCode,
                  hueActiveBefore: runtimePlan.activeBefore.includes("hue"),
                })
              ) {
                try {
                  const stopResult = await stopHue(HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM);
                  hueReleased = isHueStopCodeOk(stopResult.status.code);
                } catch (error) {
                  console.error("[LumaSync] Hue cancel after leaving it out of the start failed:", error);
                }
                hueReleaseFailed = !hueReleased;
                if (hueReleaseFailed) setStopFailedNotice(["hue"]);
              }
              applyResult = await dispatchSetLightingMode(
                { ...normalizedNextMode, targets: usbOnlyTargets },
                { force: true },
              );
            }
            const outcome = readModeApplyOutcome(applyResult, normalizedNextMode.kind);
            if (outcome.startFailure) {
              setStartFailedNotice(pickStartFailureNotice(probeNotice, outcome.startFailure));
            }
            if (applyResult !== null && outcome.refused) {
              applyRefused = true;
              runningAfterRefusal = applyResult.mode;
              if (runtimePlan.startTargets.includes("usb")) {
                targetResults.usb = {
                  ok: false,
                  code: applyResult.status.code,
                  message: applyResult.status.message,
                };
              }
            } else if (runtimePlan.startTargets.includes("usb")) {
              targetResults.usb = { ok: true };
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            applyRefused = true;
            if (runtimePlan.startTargets.includes("usb")) {
              targetResults.usb = { ok: false, code: "USB_MODE_APPLY_FAILED", message: reason };
            }
          }
        }

        // A left-out Hue was already settled above, before the retry.
        if (
          usbOnlyTargets === null &&
          applyRefused &&
          shouldReleaseHueAfterRefusal({
            hueStartedOk,
            hueStartCode: targetResults.hue?.code,
            hueActiveBefore: runtimePlan.activeBefore.includes("hue"),
            runningMode: runningAfterRefusal,
          })
        ) {
          try {
            const stopResult = await stopHue(HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM);
            hueReleased = isHueStopCodeOk(stopResult.status.code);
          } catch (error) {
            console.error("[LumaSync] Hue release after a refused mode apply failed:", error);
          }
          hueReleaseFailed = !hueReleased;
          if (hueReleaseFailed) setStopFailedNotice(["hue"]);
        }

        // Phase 3: Push initial solid color to Hue (solid mode only).
        // The backend set_lighting_mode already handles this via apply_hue_color_with_context,
        // but an explicit push here guarantees the bridge receives the latest UI color.
        if (
          hueStartedOk &&
          usbOnlyTargets === null &&
          !applyRefused &&
          normalizedNextMode.kind === LIGHTING_MODE_KIND.SOLID &&
          normalizedNextMode.solid
        ) {
          try {
            const colorResult = await setHueSolidColor({
              r: normalizedNextMode.solid.r,
              g: normalizedNextMode.solid.g,
              b: normalizedNextMode.solid.b,
              brightness: normalizedNextMode.solid.brightness,
            });
            reportHueSolidColorStatus(colorResult.status.code);
          } catch (err) {
            console.error("[LumaSync] Hue solid push after mode change non-fatal failure:", err);
          }
        }

        const merged = applyRuntimeResultToTargets(runtimePlan, targetResults);
        if (applyRefused && runningAfterRefusal.kind === LIGHTING_MODE_KIND.OFF) {
          // The backend tore the previous mode down before the start failed, so
          // nothing outputs; only a Hue stream that would not stop is still held.
          setActiveOutputTargets(hueReleaseFailed ? ["hue"] : []);
          // UI only, as on boot: the persisted mode stays for the next launch.
          if (lightingMode.kind !== LIGHTING_MODE_KIND.OFF) {
            setLightingModeState({ ...normalizedNextMode, kind: LIGHTING_MODE_KIND.OFF });
          }
        } else {
          let nextActive = merged.activeTargets;
          if (usbOnlyTargets !== null) {
            // A left-out stream that would not stop stays listed, as on boot.
            nextActive = nextActive.filter((t) => t !== "hue");
            if (hueReleaseFailed) nextActive = [...nextActive, "hue"];
          } else if (hueReleased) {
            nextActive = nextActive.filter((t) => t !== "hue");
          }
          setActiveOutputTargets(nextActive);
        }
        // Only reflect user intent in the UI when at least one backend command was
        // issued and the backend accepted it. A gate-blocked or failed start must
        // not be shown as ON, nor persisted for the next launch to restore.
        if (needsLightingModeApply && !applyRefused) {
          if (usbOnlyTargets !== null) {
            // The live mode carries the targets that ran, or every hot-reload
            // re-dispatch would hit the Hue gate again. The persisted mode and
            // `lastOutputTargets` keep Hue, so the next launch tries it again.
            setLightingModeState({ ...normalizedNextMode, targets: usbOnlyTargets });
            setSelectedOutputTargets((prev) => prev.filter((t) => t !== "hue"));
            setHueLeftOutNotice(hueLeftOutReason(runtimeHueStartConfig !== null, hueStartCode));
          } else {
            setLightingModeState(normalizedNextMode);
          }
          scheduleLightingModePersist(normalizedNextMode);
        }
      } catch (error) {
        console.error(`[LumaSync] Failed to switch lighting mode to ${normalizedNextMode.kind}:`, error);
      } finally {
        modeTransitionLockRef.current = false;
        setIsModeTransitioning(false);

        const pendingModeChange = pendingModeChangeRef.current;
        pendingModeChangeRef.current = null;
        if (pendingModeChange) void handleLightingModeChange(pendingModeChange);
      }
    },
    [
      activeOutputTargets,
      cancelBootHueRetry,
      dispatchSetLightingMode,
      handleOpenCalibration,
      hueStartConfig,
      hydrateModePayload,
      lightingMode.ambilight,
      lightingMode.kind,
      lightingMode.solid,
      reportHueSolidColorStatus,
      savedCalibration,
      scheduleLightingModePersist,
      selectedOutputTargets,
    ],
  );

  useEffect(() => {
    handleLightingModeChangeRef.current = handleLightingModeChange;
  }, [handleLightingModeChange]);

  const adoptSolidColor = useCallback((solid: SolidColorPayload) => {
    setLightingModeState({ kind: LIGHTING_MODE_KIND.SOLID, solid });
  }, []);

  return {
    lightingMode,
    selectedOutputTargets,
    activeOutputTargets,
    isModeTransitioning,
    stopFailedNotice,
    startFailedNotice,
    reportStartFailure: setStartFailedNotice,
    hueLeftOutNotice,
    reportHueLeftOut: setHueLeftOutNotice,
    bootHueRetryNotice: bootHueRetry.notice,
    scheduleBootHueRetry: bootHueRetry.schedule,
    handleLightingModeChange,
    handleOutputTargetsChange,
    dispatch: dispatchSetLightingMode,
    setLightingMode: setLightingModeState,
    adoptSolidColor,
    setSelectedOutputTargets,
    setActiveOutputTargets,
    lightingModeRef,
    lastNonOffModeRef,
    selectedOutputTargetsRef,
    activeOutputTargetsRef,
    dispatchRef,
  };
}
