import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";

import {
  normalizeLedCalibrationConfig,
  type LedCalibrationConfig,
} from "@/features/calibration/model/contracts";
import { getSerialConnectionStatus } from "@/features/device/deviceConnectionApi";
import {
  isHueStartCodeOk,
  toHueStartConfig,
  type HueStartConfig,
} from "@/features/hue/model/hueStartConfig";
import { setHueSolidColor, setLightingMode, startHue } from "@/features/mode/modeApi";
import {
  LIGHTING_MODE_KIND,
  normalizeLightingModeConfig,
  normalizeOutputTargets,
  type LightingModeConfig,
} from "@/features/mode/model/contracts";
import type { ModeRuntimeConfig } from "@/features/mode/state/useModeRuntimeConfig";
import { showNotification } from "@/features/platform/platformApi";
import { SECTION_IDS, type SectionId, type UIMode } from "@/shared/contracts/shell";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";

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
        } catch {
          // Status check failed — leave bootstrapUsbAvailable=false; we
          // still keep restoredTargets as-is below.
        }
        sink.setSelectedOutputTargets(restoredTargets);

        // Initialize hot-plug ref AFTER USB status is known
        // This prevents false "USB detected" events on startup
        sink.armUsbConnected(bootstrapUsbAvailable);

        const isActive = restoredMode.kind !== LIGHTING_MODE_KIND.OFF;
        sink.setActiveOutputTargets(isActive ? restoredTargets : []);
        // Any persisted lightingMode — even `off` — means the user already picked
        // one, so the onboarding flow must not gate them at step 1.
        if (state.lightingMode !== undefined) {
          sink.setHasInteractedWithMode(true);
        }
        const hueBootstrapConfig = toHueStartConfig(state);
        sink.setHueStartConfig(hueBootstrapConfig);

        // Deliberately no `validateHueCredentials` here — setting `hueStartConfig`
        // re-arms the reachability poll, and doing both probed the bridge twice.

        // Bug #39 — the restore is split so a USB-only Ambilight session also
        // re-applies its persisted knobs, not just a Hue-targeted one.
        if (isActive) {
          // Filter targets against live USB availability so the Rust USB gate
          // doesn't reject the bootstrap apply on a Hue-only session that
          // happens to have "usb" persisted from a previous run.
          const bootTargets = restoredTargets.filter(
            (target) => target !== "usb" || bootstrapUsbAvailable,
          );

          if (restoredTargets.includes("hue") && hueBootstrapConfig) {
            try {
              const startResult = await startHue(hueBootstrapConfig);
              if (isHueStartCodeOk(startResult.status.code)) {
                if (
                  restoredMode.kind === LIGHTING_MODE_KIND.SOLID &&
                  restoredMode.solid
                ) {
                  const colorResult = await setHueSolidColor({
                    r: restoredMode.solid.r,
                    g: restoredMode.solid.g,
                    b: restoredMode.solid.b,
                    brightness: restoredMode.solid.brightness,
                  });
                  sink.reportHueSolidColorStatus(colorResult.status.code);
                } else if (restoredMode.kind === LIGHTING_MODE_KIND.AMBILIGHT) {
                  await setLightingMode(runtimeConfig.hydrate({
                    ...restoredMode,
                    targets: bootTargets,
                  }));
                }
              }
            } catch (err) {
              console.error("[LumaSync] Bootstrap Hue start/restore failed:", err);
            }
          } else if (
            restoredMode.kind === LIGHTING_MODE_KIND.AMBILIGHT &&
            bootTargets.length > 0
          ) {
            // Without this branch the worker runs on backend defaults until the
            // next manual mode toggle.
            try {
              await setLightingMode(runtimeConfig.hydrate({
                ...restoredMode,
                targets: bootTargets,
              }));
            } catch (err) {
              console.error("[LumaSync] Bootstrap USB-only Ambilight restore failed:", err);
            }
          } else if (
            restoredMode.kind === LIGHTING_MODE_KIND.SOLID &&
            restoredMode.solid &&
            bootTargets.includes("usb")
          ) {
            // Routed through setLightingMode, small as the payload is, to keep the
            // backend mode machine aligned with what the UI paints first.
            try {
              await setLightingMode(runtimeConfig.hydrate({
                ...restoredMode,
                targets: bootTargets,
              }));
            } catch (err) {
              console.error("[LumaSync] Bootstrap USB-only Solid restore failed:", err);
            }
          }
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
