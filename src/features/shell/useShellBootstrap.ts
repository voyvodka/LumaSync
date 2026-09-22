import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";

import {
  normalizeLedCalibrationConfig,
  type LedCalibrationConfig,
} from "@/features/calibration/model/contracts";
import { getSerialConnectionStatus } from "@/features/device/deviceConnectionApi";
import {
  isHueStartCodeOk,
  isHueStopCodeOk,
  toHueStartConfig,
  type HueStartConfig,
} from "@/features/hue/model/hueStartConfig";
import { setHueSolidColor, setLightingMode, startHue, stopHue } from "@/features/mode/modeApi";
import {
  LIGHTING_MODE_KIND,
  normalizeLightingModeConfig,
  normalizeOutputTargets,
  type LightingModeConfig,
} from "@/features/mode/model/contracts";
import { readModeApplyOutcome, type ModeApplyOutcome } from "@/features/mode/state/modeApplyOutcome";
import type { ModeRuntimeConfig } from "@/features/mode/state/useModeRuntimeConfig";
import { showNotification } from "@/features/platform/platformApi";
import { SECTION_IDS, type SectionId, type UIMode } from "@/shared/contracts/shell";
import { CAPTURE_FAILURE_BUCKET, type CaptureFailureNotice } from "@/shared/contracts/capture";
import { HUE_RUNTIME_TRIGGER_SOURCE, type HueRuntimeTarget } from "@/shared/contracts/hue";

import { pushTrayLabels } from "./useTrayIntegration";
import { initWindowLifecycle, loadShellState } from "./windowLifecycle";

/**
 * Every slice bootstrap writes. Passed as one bag so the ordering spine stays
 * visible in a single function instead of spreading across the shell.
 */
export interface ShellBootstrapSink {
  t: TFunction;
  setUIMode: (mode: UIMode) => void;
  setActiveSection: (sectionId: SectionId) => void;
  setSavedCalibration: (calibration: LedCalibrationConfig | undefined) => void;
  setHasCompletedOnboarding: (completed: boolean) => void;
  setHasInteractedWithMode: (interacted: boolean) => void;
  setLightingMode: (mode: LightingModeConfig) => void;
  setSelectedOutputTargets: (targets: HueRuntimeTarget[]) => void;
  setActiveOutputTargets: (targets: HueRuntimeTarget[]) => void;
  setHueStartConfig: (config: HueStartConfig | null) => void;
  armUsbConnected: (connected: boolean) => void;
  runtimeConfig: ModeRuntimeConfig;
  reportHueSolidColorStatus: (code: string) => void;
  /** The interactive start's toast, raised when a restored mode fails to start. */
  reportStartFailure: (notice: CaptureFailureNotice) => void;
}

/** Runs the shell boot sequence exactly once and reports when it has settled. */
export function useShellBootstrap(sink: ShellBootstrapSink): { bootstrapDone: boolean } {
  const [bootstrapDone, setBootstrapDone] = useState(false);
  const bootstrapRanRef = useRef(false);

  useEffect(() => {
    // StrictMode guard: prevent double bootstrap in dev mode.
    // React.StrictMode unmounts/remounts, running the effect twice.
    // A ref guard ensures only the first invocation proceeds.
    if (bootstrapRanRef.current) return;
    bootstrapRanRef.current = true;
    const { t, runtimeConfig } = sink;

    async function bootstrap() {
      try {
        // Before the window is sized and shown, or it appears at full size
        // still rendering the compact layout.
        const state = await loadShellState();
        sink.setUIMode(state.uiMode ?? "compact");

        // Restore window geometry immediately — before any heavy async work —
        // so the window settles into its saved position without a visible jump.
        await initWindowLifecycle({
          // A4.1 — tell the user the app is still running in the tray the first
          // time they close the window. `trayHintShown` in shellStore keeps it to
          // once per install; a denied permission is logged, never blocking.
          onFirstCloseToTray: () => {
            void (async () => {
              try {
                const result = await showNotification({
                  title: t("tray:hint.title"),
                  body: t("tray:hint.body"),
                  kind: "info",
                });
                if (result.status !== "shown") {
                  console.info(
                    "[LumaSync] tray hint notification not delivered:",
                    result.code,
                    result.message ?? "",
                  );
                }
              } catch (err) {
                console.warn("[LumaSync] tray hint notification invoke failed:", err);
              }
            })();
          },
        });

        // Map old section IDs to new ones for backward compatibility
        const sectionMap: Record<string, SectionId> = {
          // Legacy IDs from persisted state before navigation restructure
          general: SECTION_IDS.LIGHTS,
          control: SECTION_IDS.LIGHTS,
          calibration: SECTION_IDS.LED_SETUP,
          device: SECTION_IDS.DEVICES,
          settings: SECTION_IDS.SYSTEM,
          "startup-tray": SECTION_IDS.SYSTEM,
          language: SECTION_IDS.SYSTEM,
          "about-logs": SECTION_IDS.SYSTEM,
          telemetry: SECTION_IDS.SYSTEM,
          // Current IDs (map to themselves)
          lights: SECTION_IDS.LIGHTS,
          "led-setup": SECTION_IDS.LED_SETUP,
          devices: SECTION_IDS.DEVICES,
          system: SECTION_IDS.SYSTEM,
          "room-map": SECTION_IDS.ROOM_MAP,
        };
        // On first launch keep the default LIGHTS section.
        // On a page refresh (sessionStorage survives the reload) restore the last section.
        const isPageRefresh = sessionStorage.getItem("lumasync_session") === "1";
        sessionStorage.setItem("lumasync_session", "1");

        if (isPageRefresh) {
          const mappedSection = sectionMap[state.lastSection] ?? SECTION_IDS.LIGHTS;
          sink.setActiveSection(mappedSection);
        }
        const hydratedCalibration = normalizeLedCalibrationConfig(state.ledCalibration);
        sink.setSavedCalibration(hydratedCalibration);
        // Prime the ref synchronously so the bootstrap set_lighting_mode
        // fired below already carries the calibration — the
        // useEffect that mirrors state->ref has not flushed yet.
        runtimeConfig.setCalibration(hydratedCalibration);
        // Fresh installs land on `undefined`; treat that as "never completed" so
        // the banner mounts once for upgraders too — no destructive migration.
        sink.setHasCompletedOnboarding(state.hasCompletedOnboarding === true);
        // Synchronous prime so the bootstrap set_lighting_mode fired below
        // already honours the persisted display / preset / correction knobs.
        runtimeConfig.prime(state);
        const restoredMode = normalizeLightingModeConfig(state.lightingMode);
        const restoredTargets = normalizeOutputTargets(state.lastOutputTargets);
        // Prime the ambilight ref synchronously: a same-tick dispatch (hot-reload,
        // USB hot-plug delta-start) fires before `setLightingMode` flushes and
        // would otherwise ship backend defaults instead of the persisted knobs.
        runtimeConfig.setAmbilight(restoredMode.ambilight);
        sink.setLightingMode(restoredMode);

        // H3 — this snapshot must NOT strip "usb" from the persisted targets;
        // cold launch races auto-reconnect. See docs/architecture/ui-and-shell.md.
        // `armUsbConnected` below tracks the snapshot and must not follow suit.
        let bootstrapUsbAvailable = false;
        try {
          const connectionStatus = await getSerialConnectionStatus();
          bootstrapUsbAvailable = connectionStatus.connected;
        } catch (err) {
          // Status check failed — leave bootstrapUsbAvailable=false; we
          // still keep restoredTargets as-is below.
          console.error("[LumaSync] bootstrap serial status check failed:", err);
        }
        sink.setSelectedOutputTargets(restoredTargets);

        // Initialize hot-plug ref AFTER USB status is known
        // This prevents false "USB detected" events on startup
        sink.armUsbConnected(bootstrapUsbAvailable);

        const isActive = restoredMode.kind !== LIGHTING_MODE_KIND.OFF;
        // Any persisted lightingMode — even `off` — means the user already picked
        // one, so the onboarding flow must not gate them at step 1.
        if (state.lightingMode !== undefined) {
          sink.setHasInteractedWithMode(true);
        }
        const hueBootstrapConfig = toHueStartConfig(state);
        sink.setHueStartConfig(hueBootstrapConfig);

        // Deliberately no `validateHueCredentials` here — setting `hueStartConfig`
        // re-arms the reachability poll, and doing both probed the bridge twice.

        if (isActive) {
          // Filter targets against live USB availability so the Rust USB gate
          // doesn't reject the bootstrap apply on a Hue-only session that
          // happens to have "usb" persisted from a previous run.
          const bootTargets = restoredTargets.filter(
            (target) => target !== "usb" || bootstrapUsbAvailable,
          );
          const restore = await restoreLightingSession({
            mode: restoredMode,
            bootTargets,
            hueConfig: hueBootstrapConfig,
            runtimeConfig,
            reportHueSolidColorStatus: sink.reportHueSolidColorStatus,
          });
          // Active targets are written from the outcome, never optimistically:
          // a target set before anything ran is what painted HUE STREAMING and
          // CAP OK over a session the backend had refused.
          sink.setActiveOutputTargets(restore.activeTargets);
          if (!restore.running) {
            // UI only — the persisted mode stays, so the next launch retries it
            // once the cause (a permission, an unplugged strip) is fixed.
            sink.setLightingMode({ ...restoredMode, kind: LIGHTING_MODE_KIND.OFF });
          }
          // A launch against an unplugged display must not toast; every other
          // failure needs the user, and without the toast they only see Off.
          if (
            restore.startFailure &&
            restore.startFailure.bucket !== CAPTURE_FAILURE_BUCKET.DISPLAY
          ) {
            sink.reportStartFailure(restore.startFailure);
          }
        } else {
          sink.setActiveOutputTargets([]);
        }

        // Push localized tray labels to Rust
        pushTrayLabels();

        // The LED preview surfaces are never auto-opened on boot — persisted
        // visibility is deliberately not acted on here.

        // Mark bootstrap complete — the hot-plug reconciler may now run
        setBootstrapDone(true);
      } catch (err) {
        console.warn("[LumaSync] Shell lifecycle bootstrap error:", err);
        // Still mark bootstrap complete so UI is not permanently blocked
        setBootstrapDone(true);
      }
    }

    bootstrap();
  }, []);

  return { bootstrapDone };
}

interface LightingSessionRestoreInput {
  mode: LightingModeConfig;
  bootTargets: HueRuntimeTarget[];
  hueConfig: HueStartConfig | null;
  runtimeConfig: ModeRuntimeConfig;
  reportHueSolidColorStatus: (code: string) => void;
}

interface LightingSessionRestore {
  /** The backend is running the restored mode. */
  running: boolean;
  activeTargets: HueRuntimeTarget[];
  startFailure: CaptureFailureNotice | null;
}

/**
 * The boot half of the interactive slow path in `useLightingModeOrchestrator`,
 * with the same phase order and the same reading of the reply. The one thing it
 * adds is the rollback: at boot nothing else can be using the stream it started.
 */
export async function restoreLightingSession({
  mode,
  bootTargets,
  hueConfig,
  runtimeConfig,
  reportHueSolidColorStatus,
}: LightingSessionRestoreInput): Promise<LightingSessionRestore> {
  const hueWanted = bootTargets.includes("hue");
  let hueStarted = false;

  // Hue first: `snapshot_hue_output_context()` needs a live stream to hand the
  // worker, or it comes up with `hue_output=None` and never drives the bulbs.
  if (hueWanted && hueConfig) {
    try {
      const startResult = await startHue(hueConfig);
      hueStarted = isHueStartCodeOk(startResult.status.code);
      if (!hueStarted) {
        console.warn("[LumaSync] Bootstrap Hue start refused:", startResult.status.code);
      }
    } catch (err) {
      console.error("[LumaSync] Bootstrap Hue start failed:", err);
    }
  }

  // Same rule as the interactive path: Ambilight is still attempted after a
  // failed Hue start. A gated start leaves no stream context and nothing
  // retrying it, so the Rust Hue gate refuses this apply (HUE_NOT_READY) and
  // the restore reads as not running — Off, never a pending retry.
  const hueTransientFail = !hueStarted && hueWanted && mode.kind === LIGHTING_MODE_KIND.AMBILIGHT;
  const usbWanted = bootTargets.includes("usb");
  if (!usbWanted && !hueStarted && !hueTransientFail) {
    return { running: false, activeTargets: [], startFailure: null };
  }

  let outcome: ModeApplyOutcome;
  try {
    // Routed through setLightingMode even for Solid, to keep the backend mode
    // machine aligned with what the UI paints first — and, since Bug #39, so a
    // USB-only session re-applies its persisted knobs rather than backend defaults.
    const applyResult = await setLightingMode(
      runtimeConfig.hydrate({ ...mode, targets: bootTargets }),
    );
    outcome = readModeApplyOutcome(applyResult, mode.kind);
  } catch (err) {
    console.error("[LumaSync] Bootstrap lighting mode restore failed:", err);
    outcome = { refused: true, startFailure: null };
  }

  if (outcome.refused) {
    console.warn(
      `[LumaSync] Bootstrap restore of ${mode.kind} refused by the backend; showing Off.`,
    );
    // The bridge allows one entertainment streamer. Holding it for a mode that
    // is not running sends nothing and locks out every other client.
    let hueStillHeld = false;
    if (hueStarted) {
      try {
        const stopResult = await stopHue(HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM);
        hueStillHeld = !isHueStopCodeOk(stopResult.status.code);
      } catch (err) {
        hueStillHeld = true;
        console.error("[LumaSync] Bootstrap Hue rollback after refused restore failed:", err);
      }
    }
    // A stream that would not stop stays listed, or the chip denies a session
    // the bridge still counts as its streamer.
    return {
      running: false,
      activeTargets: hueStillHeld ? ["hue"] : [],
      startFailure: outcome.startFailure,
    };
  }

  // The backend already pushes the colour through apply_hue_color_with_context;
  // the explicit push guarantees the bridge has the colour the UI shows.
  if (hueStarted && mode.kind === LIGHTING_MODE_KIND.SOLID && mode.solid) {
    try {
      const colorResult = await setHueSolidColor({
        r: mode.solid.r,
        g: mode.solid.g,
        b: mode.solid.b,
        brightness: mode.solid.brightness,
      });
      reportHueSolidColorStatus(colorResult.status.code);
    } catch (err) {
      console.error("[LumaSync] Bootstrap Hue solid push failed:", err);
    }
  }

  const activeTargets: HueRuntimeTarget[] = [];
  if (usbWanted) activeTargets.push("usb");
  if (hueStarted) activeTargets.push("hue");
  return { running: true, activeTargets, startFailure: outcome.startFailure };
}
