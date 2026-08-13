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
        // Restore window geometry immediately — before any heavy async work —
        // so the window settles into its saved position without a visible jump.
        await initWindowLifecycle({
          // A4.1 — Trigger an OS-level notification the first time the
          // user closes the window, so they know the app is still running
          // in the tray (matches Spotify / Slack behaviour). The
          // trayHintShown flag in shellStore guarantees this fires only
          // once per install. The Rust command is never-throws and
          // returns a coded status — we log a denied permission as
          // diagnostic context and silently continue, since the hint is
          // a nice-to-have, not a blocker for the close flow.
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

        const state = await loadShellState();
        // Always start in compact — ignore any persisted uiMode.
        sink.setUIMode("compact");
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
        // v1.5 W2-B4 — fresh installs land on `undefined`; treat that as
        // "never completed" so the onboarding banner mounts. Existing
        // v1.4 users upgrading without the flag also see it once and
        // can dismiss with one click — no destructive migration.
        sink.setHasCompletedOnboarding(state.hasCompletedOnboarding === true);
        // Synchronous prime so the bootstrap set_lighting_mode fired below
        // already honours the persisted display / preset / correction knobs.
        runtimeConfig.prime(state);
        const restoredMode = normalizeLightingModeConfig(state.lightingMode);
        const restoredTargets = normalizeOutputTargets(state.lastOutputTargets);
        // v1.5 H1 — prime the ambilight ref synchronously so any same-tick
        // dispatch fired before `setLightingMode(restoredMode)` flushes
        // (color-correction / firmware-profile / Hue-intensity hot-reload,
        // USB hot-plug delta-start) still carries the persisted saturation /
        // blackBorderDetection / smoothing-preset values. The mirror effect
        // keeps the ref in sync with subsequent state updates.
        runtimeConfig.setAmbilight(restoredMode.ambilight);
        sink.setLightingMode(restoredMode);

        // v1.5 H3 — read live USB connection state but DO NOT strip "usb"
        // from selectedOutputTargets when the snapshot returns
        // `connected: false`. Cold launch races against
        // `tryAutoReconnect`'s 2 s BOOTLOADER_SETTLE_DELAY_MS: ~20-30%
        // of starts the bootstrap finishes first, sees `connected: false`,
        // and silently drops the user's persisted USB target. Auto-reconnect
        // then completes and emits `connected: true` — but "usb" was already
        // gone from targets state, so the membership check in the hot-plug
        // reconciler is a noop. End result: the Lights output is silently
        // disabled until the user toggles it manually.
        //
        // Fix (Opsiyon A): keep "usb" in `selectedOutputTargets` regardless
        // of the bootstrap snapshot. `modeGuard` already shows visual
        // disabled state when `isConnected === false`, so user clarity is
        // preserved. The hot-plug reconciler handles the connect-arrival
        // side: its `includes("usb")` membership check passes once
        // auto-reconnect emits, and the LED setup section flips to OK.
        //
        // `armUsbConnected(bootstrapUsbAvailable)` stays unchanged — it
        // tracks "was USB physically connected last time we checked", not
        // "is it in selectedTargets". Without it the false→true transition
        // would refire on every cold start.
        let bootstrapUsbAvailable = false;
        try {
          const connectionStatus = await getSerialConnectionStatus();
          bootstrapUsbAvailable = connectionStatus.connected;
        } catch {
          // Status check failed — leave bootstrapUsbAvailable=false; we
          // still keep restoredTargets as-is below.
        }
        // Always honour the persisted target set; do NOT strip "usb"
        // when the bootstrap snapshot reports it offline.
        sink.setSelectedOutputTargets(restoredTargets);

        // Initialize hot-plug ref AFTER USB status is known
        // This prevents false "USB detected" events on startup
        sink.armUsbConnected(bootstrapUsbAvailable);

        const isActive = restoredMode.kind !== LIGHTING_MODE_KIND.OFF;
        sink.setActiveOutputTargets(isActive ? restoredTargets : []);
        // v1.5 W2-B4 — prime the LIGHTS-step guard from disk. Any persisted
        // lightingMode (even `off`) means the user picked a mode at some
        // point, so the onboarding flow should not gate them at step 1
        // waiting for a fresh click. Truly fresh installs land here with
        // `state.lightingMode === undefined` and the guard stays false.
        if (state.lightingMode !== undefined) {
          sink.setHasInteractedWithMode(true);
        }
        const hueBootstrapConfig = toHueStartConfig(state);
        sink.setHueStartConfig(hueBootstrapConfig);

        // NOTE: we deliberately do NOT call `validateHueCredentials` here.
        // Setting `hueStartConfig` re-arms the visibility-aware
        // reachability poll, which fires its own immediate mount tick — so
        // the first credential probe lands ~1-2 s after this line resolves.
        // Doing a bootstrap validate call as well meant every launch hit
        // the Bridge twice (once here, once from the poll's mount tick)
        // for the same answer. The chip starts as `hueReachable=false` and
        // flips green on the poll's first successful tick.

        // Bootstrap path is split in two stages so the persisted Ambilight
        // payload (saturation / blackBorderDetection / smoothing preset) gets
        // pushed to Rust on every boot — not only when Hue happens to be one
        // of the targets. Bug #39: previously the entire restore block was
        // gated on `targets.includes("hue") && hueBootstrapConfig`, so a
        // USB-only Ambilight session never re-applied its persisted knobs and
        // the worker came up with backend defaults (saturation 1.0 / black
        // borders off). The Hue branch still owns its own `startHue` +
        // `setHueSolidColor` orchestration; the new outer branch covers any
        // active mode regardless of the target mix.
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
            // USB-only (or Hue-not-configured) Ambilight bootstrap: push the
            // persisted payload to Rust so saturation / blackBorderDetection /
            // smoothing preset survive a restart. Without this branch the
            // worker uses backend defaults until the next manual mode toggle.
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
            // USB-only Solid bootstrap: same rationale as above. The Solid
            // payload itself is small (RGB + brightness) but going through
            // setLightingMode keeps the backend's mode state machine aligned
            // with what the UI is showing on first paint.
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

        // v1.6 — the LED preview surfaces are NEVER auto-opened on boot. They
        // open only when the user explicitly asks (LED Setup "Test & Preview"
        // button or the tray "Show LED Preview" item). Persisted visibility is
        // intentionally not acted on here.

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
