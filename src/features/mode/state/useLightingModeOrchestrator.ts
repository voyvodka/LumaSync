import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import type { HueStartConfig } from "@/features/hue/model/hueStartConfig";
import { isHueStartCodeOk, isHueStopCodeOk, toHueStartConfig } from "@/features/hue/model/hueStartConfig";
import { loadShellState, saveShellState } from "@/features/shell/windowLifecycle";
import {
  AMBILIGHT_CAPTURE_REASON,
  describeCaptureFailure,
  isScreenCaptureBlocked,
  type CaptureFailureNotice,
} from "@/shared/contracts/capture";
import { HUE_RUNTIME_TRIGGER_SOURCE, type HueRuntimeTarget } from "@/shared/contracts/hue";
import { LIGHTING_MODE_STATUS } from "@/shared/contracts/lighting";

import { getScreenCapturePermission } from "../captureApi";
import { setHueSolidColor, startHue, stopHue, stopLighting } from "../modeApi";
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
import { useLightingModeDispatch, type LightingModeDispatcher } from "./useLightingModeDispatch";
import { useLightingModePersistence } from "./useLightingModePersistence";
import type { ModeRuntimeConfig } from "./useModeRuntimeConfig";

/** How long the "stop failed for these targets" toast stays up. */
const STOP_FAILED_NOTICE_MS = 5_000;

/** Longer than the stop toast: this one asks the user to go change a setting. */
const START_FAILED_NOTICE_MS = 8_000;

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
  const [isModeTransitioning, setIsModeTransitioning] = useState(false);
  // A1.2 — surfaces the targets whose stop_lighting / stop_hue_stream invoke
  // failed during a delta-stop, so the chip stays active instead of silently
  // lying about state. Banner auto-dismisses; user can retry by toggling.
  const [stopFailedNotice, setStopFailedNotice] = useState<HueRuntimeTarget[] | null>(null);
  // Raised only from the slow path below, which nothing but a user gesture
  // reaches — bootstrap restore calls `modeApi.setLightingMode` directly, so a
  // launch against an unplugged display must not toast.
  const [startFailedNotice, setStartFailedNotice] = useState<CaptureFailureNotice | null>(null);

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

  const handleOutputTargetsChange = useCallback(async (targets: HueRuntimeTarget[]) => {
    const normalizedTargets = normalizeOutputTargets(targets);
    const prevTargets = selectedOutputTargets;
    setSelectedOutputTargets(normalizedTargets);
    try {
      await saveShellState({ lastOutputTargets: normalizedTargets });
    } catch (err) {
      console.error("[LumaSync] saveShellState(lastOutputTargets) failed:", err);
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
    if (successfullyStopped.length > 0) {
      const nextActive = currentActive.filter((t) => !successfullyStopped.includes(t));
      setActiveOutputTargets(nextActive);
    }
    if (failedToStop.length > 0) {
      setStopFailedNotice(failedToStop);
    }

    // Delta-start: for each added target, start the current mode on it
    for (const target of addedTargets) {
      if (target === "usb") {
        // Note: was previously using invoke("set_lighting_mode", { request: {...} })
        // which is the wrong key name (Tauri expects "payload") and silently failed.
        try {
          await dispatchSetLightingMode({
            kind: lightingMode.kind,
            solid: lightingMode.solid,
            ambilight: lightingMode.ambilight,
            targets: normalizedTargets,
          }, { force: true });
          setActiveOutputTargets((prev) => [...new Set([...prev, "usb" as HueRuntimeTarget])]);
        } catch {
          // D-06: silently skip failed target, existing targets continue
          console.warn("[seamless-switch] USB delta-start failed, skipping");
        }
      }
      if (target === "hue") {
        try {
          const latestShellState = await loadShellState();
          const runtimeHueConfig = toHueStartConfig(latestShellState) ?? hueStartConfig;
          if (!runtimeHueConfig) {
            console.warn("[seamless-switch] Hue delta-start skipped — no bridge config");
            continue;
          }
          const hueResult = await startHue(runtimeHueConfig);
          if (isHueStartCodeOk(hueResult.status.code)) {
            setActiveOutputTargets((prev) => [...new Set([...prev, "hue" as HueRuntimeTarget])]);
            // Re-apply lighting mode so the ambilight worker picks up the now-live
            // Hue stream context. Without this, the running worker has hue_output=None
            // and never sends colors to Hue (solid color push handles SOLID mode too).
            try {
              await dispatchSetLightingMode({
                kind: lightingMode.kind,
                solid: lightingMode.solid,
                ambilight: lightingMode.ambilight,
                targets: normalizedTargets,
              }, { force: true });
            } catch {
              // Non-fatal for ambilight worker restart; fall through to solid push
            }
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
          }
        } catch {
          // D-06: silently skip failed target, existing targets continue
          console.warn("[seamless-switch] Hue delta-start failed, skipping");
        }
      }
    }
  }, [lightingMode, selectedOutputTargets, hueStartConfig, hydrateModePayload, dispatchSetLightingMode, reportHueSolidColorStatus]);


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
          // Optimization: Execute stop commands concurrently for independent targets
          // (USB and Hue) to minimize shutdown phase and mode transition latency.
          await Promise.all(
            runtimePlan.stopTargets.map(async (target) => {
              if (target === "usb") {
                await stopLighting();
                targetResults.usb = { ok: true };
              }
              if (target === "hue") {
                const hueResult = await stopHue();
                targetResults.hue = {
                  ok: isHueStopCodeOk(hueResult.status.code),
                  code: hueResult.status.code,
                  message: hueResult.status.message,
                };
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
        // A transient Hue failure still starts the worker: it runs without Hue
        // context and the stream auto-reconnects within ~30 s.
        const hueTransientFail =
          !hueStartedOk &&
          normalizedNextMode.kind === LIGHTING_MODE_KIND.AMBILIGHT &&
          runtimePlan.startTargets.includes("hue");
        const needsLightingModeApply =
          runtimePlan.startTargets.includes("usb") ||
          (runtimePlan.startTargets.includes("hue") && hueStartedOk) ||
          hueTransientFail;

        if (needsLightingModeApply) {
          // Advisory probe, never a gate: the OS prompt only appears from the
          // Rust start path below, so short-circuiting here would leave a
          // first-run user unable to ever grant the permission.
          if (normalizedNextMode.kind === LIGHTING_MODE_KIND.AMBILIGHT) {
            const permission = await getScreenCapturePermission();
            if (isScreenCaptureBlocked(permission.code)) {
              setStartFailedNotice(describeCaptureFailure(AMBILIGHT_CAPTURE_REASON.PERMISSION_DENIED));
            }
          }
          try {
            const applyResult = await dispatchSetLightingMode(normalizedNextMode, { force: true });
            // A failed capture start resolves as `Ok` carrying a status, so it
            // lands here rather than in the catch below. The reason is free text
            // in `details`; `describeCaptureFailure` is the only thing that reads it.
            if (applyResult?.status?.code === LIGHTING_MODE_STATUS.AMBILIGHT_MODE_START_FAILED) {
              setStartFailedNotice(describeCaptureFailure(applyResult.status.details));
            }
            if (runtimePlan.startTargets.includes("usb")) {
              targetResults.usb = { ok: true };
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (runtimePlan.startTargets.includes("usb")) {
              targetResults.usb = { ok: false, code: "USB_MODE_APPLY_FAILED", message: reason };
            }
          }
        }

        // Phase 3: Push initial solid color to Hue (solid mode only).
        // The backend set_lighting_mode already handles this via apply_hue_color_with_context,
        // but an explicit push here guarantees the bridge receives the latest UI color.
        if (
          hueStartedOk &&
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
        setActiveOutputTargets(merged.activeTargets);
        // Only reflect user intent in the UI when at least one backend command was
        // issued. If all targets were gate-blocked (e.g. Hue config missing), the
        // mode stays unchanged so the UI matches actual backend state.
        if (needsLightingModeApply) {
          setLightingModeState(normalizedNextMode);
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

  // Keep handleLightingModeChangeRef in sync so tray listeners always use latest handler

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
