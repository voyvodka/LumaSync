import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";

import {
  normalizeLedCalibrationConfig,
  type LedCalibrationConfig,
} from "@/features/calibration/model/contracts";
import { getSerialConnectionStatus } from "@/features/device/deviceConnectionApi";
import { toHueStartConfig, type HueStartConfig } from "@/features/hue/model/hueStartConfig";
import type { BootLightingInput } from "@/features/mode/state/useLightingModeOrchestrator";
import { showNotification } from "@/features/platform/platformApi";
import { SECTION_IDS, type SectionId, type UIMode } from "@/shared/contracts/shell";

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
  setHueStartConfig: (config: HueStartConfig | null) => void;
  armUsbConnected: (connected: boolean) => void;
  /**
   * The launch restore. Rust reads the saved mode and outputs itself, waits
   * out a held Hue area once, and leaves the saved choice alone whatever runs.
   */
  restoreLighting: (saved: BootLightingInput) => Promise<void>;
}

/** Runs the shell boot sequence exactly once and reports when it has settled. */
export function useShellBootstrap(sink: ShellBootstrapSink): { bootstrapDone: boolean } {
  const [bootstrapDone, setBootstrapDone] = useState(false);
  const bootstrapRanRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot boot sequence; it must not re-run when the sink's identity changes
  useEffect(() => {
    // StrictMode guard: prevent double bootstrap in dev mode.
    // React.StrictMode unmounts/remounts, running the effect twice.
    // A ref guard ensures only the first invocation proceeds.
    if (bootstrapRanRef.current) return;
    bootstrapRanRef.current = true;
    const { t } = sink;

    async function bootstrap() {
      try {
        // Before the window is sized and shown, or it appears at full size
        // still rendering the compact layout.
        const state = await loadShellState();
        sink.setUIMode(state.uiMode ?? "compact");

        // Restore window geometry immediately — before any heavy async work —
        // so the window settles into its saved position without a visible jump.
        await initWindowLifecycle({
          // Tell the user the app is still running in the tray the first
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
        // Fresh installs land on `undefined`; treat that as "never completed" so
        // the banner mounts once for upgraders too — no destructive migration.
        sink.setHasCompletedOnboarding(state.hasCompletedOnboarding === true);

        // H3 — the restore must NOT strip "usb" from the persisted targets; cold
        // launch races auto-reconnect. See docs/architecture/ui-and-shell.md.
        // Rust keeps it selected and runs without it while no strip is there;
        // `armUsbConnected` below tracks the snapshot and must not follow suit.
        let bootstrapUsbAvailable = false;
        try {
          const connectionStatus = await getSerialConnectionStatus();
          bootstrapUsbAvailable = connectionStatus.connected;
        } catch (err) {
          console.error("[LumaSync] bootstrap serial status check failed:", err);
        }

        // Initialize hot-plug ref AFTER USB status is known
        // This prevents false "USB detected" events on startup
        sink.armUsbConnected(bootstrapUsbAvailable);

        // Any persisted lightingMode — even `off` — means the user already picked
        // one, so the onboarding flow must not gate them at step 1.
        if (state.lightingMode !== undefined) {
          sink.setHasInteractedWithMode(true);
        }
        sink.setHueStartConfig(toHueStartConfig(state));

        // Deliberately no `validateHueCredentials` here — setting `hueStartConfig`
        // re-arms the reachability poll, and doing both probed the bridge twice.

        // Always asked, Off included: it is what tells Rust the saved choice.
        await sink.restoreLighting({ lightingMode: state.lightingMode });

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

    void bootstrap();
  }, []);

  return { bootstrapDone };
}
