/**
 * App.tsx — Settings shell bootstrap
 *
 * Mounts the SettingsLayout, manages active section state,
 * and bridges shell persistence (window lifecycle + section restore).
 *
 * Phase 1 scope:
 *  - Renders sidebar + content settings shell
 *  - Restores last visited section from shell store on mount
 *  - Persists active section on every change
 *  - Registers close-to-tray hint listener (one-time educational hint)
 *  - Renders under i18n providers initialized in main.tsx
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { SettingsLayout } from "./features/settings/SettingsLayout";
import { CalibrationOverlay } from "./features/calibration/ui/CalibrationOverlay";
import {
  shouldAutoOpenCalibrationOnConnection,
  startCalibrationFromSettings,
  type CalibrationOverlayStep,
} from "./features/calibration/state/entryFlow";
import { useDeviceConnection } from "./features/device/useDeviceConnection";
import {
  canEnableLedMode,
  MODE_GUARD_REASONS,
} from "./features/mode/state/modeGuard";
import {
  LIGHTING_MODE_KIND,
  normalizeLightingModeConfig,
  type LightingModeConfig,
} from "./features/mode/model/contracts";
import {
  setLightingMode,
  startHue,
  stopLighting,
  stopHue,
} from "./features/mode/modeApi";
import {
  applyRuntimeResultToTargets,
  resolveHueRuntimePlan,
  type HueTargetCommandResult,
} from "./features/mode/state/hueModeRuntimeFlow";
import {
  normalizeLedCalibrationConfig,
  type LedCalibrationConfig,
} from "./features/calibration/model/contracts";
import {
  initWindowLifecycle,
  loadShellState,
  saveShellState,
} from "./features/shell/windowLifecycle";
import {
  SECTION_IDS,
  type SectionId,
} from "./shared/contracts/shell";
import type { HueRuntimeTarget } from "./shared/contracts/hue";

const DEFAULT_OUTPUT_TARGETS: HueRuntimeTarget[] = ["usb"];

interface HueStartConfig {
  bridgeIp: string;
  username: string;
  areaId: string;
}

function normalizeOutputTargets(value: unknown): HueRuntimeTarget[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_OUTPUT_TARGETS];
  }

  const targetSet = new Set(value.filter((target): target is HueRuntimeTarget => target === "usb" || target === "hue"));
  if (targetSet.size === 0) {
    return [...DEFAULT_OUTPUT_TARGETS];
  }

  return ["usb", "hue"].filter((target): target is HueRuntimeTarget => targetSet.has(target as HueRuntimeTarget));
}

function toHueStartConfig(state: {
  lastHueBridge?: { ip: string };
  hueAppKey?: string;
  lastHueAreaId?: string;
}): HueStartConfig | null {
  const bridgeIp = state.lastHueBridge?.ip?.trim();
  const username = state.hueAppKey?.trim();
  const areaId = state.lastHueAreaId?.trim();

  if (!bridgeIp || !username || !areaId) {
    return null;
  }

  return { bridgeIp, username, areaId };
}

function isHueStartCodeOk(code: string): boolean {
  return code === "HUE_STREAM_RUNNING"
    || code === "HUE_STREAM_STARTING"
    || code === "HUE_START_NOOP_ALREADY_ACTIVE";
}

function isHueStopCodeOk(code: string): boolean {
  return code === "HUE_STREAM_STOPPED";
}

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>(SECTION_IDS.GENERAL);
  const [savedCalibration, setSavedCalibration] = useState<LedCalibrationConfig | undefined>(undefined);
  const [lightingMode, setLightingModeState] = useState<LightingModeConfig>({ kind: LIGHTING_MODE_KIND.OFF });
  const [selectedOutputTargets, setSelectedOutputTargets] = useState<HueRuntimeTarget[]>([...DEFAULT_OUTPUT_TARGETS]);
  const [activeOutputTargets, setActiveOutputTargets] = useState<HueRuntimeTarget[]>([]);
  const [hueStartConfig, setHueStartConfig] = useState<HueStartConfig | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayStep, setOverlayStep] = useState<CalibrationOverlayStep>("editor");
  const [lifecycleReady, setLifecycleReady] = useState(false);
  const { isConnected } = useDeviceConnection();
  const wasConnectedRef = useRef(false);
  const autoOpenTriggeredRef = useRef(false);

  useEffect(() => {
    async function bootstrap() {
      try {
        const state = await loadShellState();
        setActiveSection(state.lastSection);
        setSavedCalibration(normalizeLedCalibrationConfig(state.ledCalibration));
        const restoredMode = normalizeLightingModeConfig(state.lightingMode);
        const restoredTargets = normalizeOutputTargets(state.lastOutputTargets);
        setLightingModeState(restoredMode);
        setSelectedOutputTargets(restoredTargets);
        setActiveOutputTargets(restoredMode.kind === LIGHTING_MODE_KIND.OFF ? [] : restoredTargets);
        setHueStartConfig(toHueStartConfig(state));

        await initWindowLifecycle({
          onFirstCloseToTray: () => {
            console.info(
              "[LumaSync] Hint: The app is still running in the system tray. " +
                "Click the tray icon to reopen settings."
            );
          },
        });
      } catch (err) {
        console.warn("[LumaSync] Shell lifecycle bootstrap error:", err);
      } finally {
        setLifecycleReady(true);
      }
    }

    bootstrap();
  }, []);

  const handleSectionChange = useCallback(async (sectionId: SectionId) => {
    setActiveSection(sectionId);
    try {
      await saveShellState({ lastSection: sectionId });
    } catch {}
  }, []);

  const openCalibrationOverlay = useCallback((step: CalibrationOverlayStep = "editor") => {
    setOverlayStep(step);
    setOverlayOpen(true);
  }, []);

  useEffect(() => {
    const shouldOpen = shouldAutoOpenCalibrationOnConnection({
      connected: isConnected,
      wasConnected: wasConnectedRef.current,
      hasCalibration: Boolean(savedCalibration),
      alreadyAutoOpened: autoOpenTriggeredRef.current,
    });

    if (shouldOpen) {
      autoOpenTriggeredRef.current = true;
      openCalibrationOverlay("template");
    }

    wasConnectedRef.current = isConnected;
  }, [isConnected, openCalibrationOverlay, savedCalibration]);

  const handleOpenCalibration = useCallback(() => {
    const entry = startCalibrationFromSettings(savedCalibration);
    if (entry.open) {
      openCalibrationOverlay(entry.step);
    }
  }, [openCalibrationOverlay, savedCalibration]);

  const handleOutputTargetsChange = useCallback(async (targets: HueRuntimeTarget[]) => {
    const normalizedTargets = normalizeOutputTargets(targets);
    setSelectedOutputTargets(normalizedTargets);
    try {
      await saveShellState({ lastOutputTargets: normalizedTargets });
    } catch {}
  }, []);

  const handleLightingModeChange = useCallback(
    async (nextMode: LightingModeConfig) => {
      const normalizedNextMode = normalizeLightingModeConfig(nextMode);
      const requiresCalibration = !savedCalibration
        && normalizedNextMode.kind !== LIGHTING_MODE_KIND.OFF;

      if (requiresCalibration) {
        openCalibrationOverlay("template");
        return;
      }

      try {
        if (normalizedNextMode.kind === LIGHTING_MODE_KIND.OFF) {
          const runtimePlan = resolveHueRuntimePlan({
            action: "stop",
            selectedTargets: selectedOutputTargets,
            activeTargets: activeOutputTargets,
            userInitiated: true,
            reconnectingTargets: activeOutputTargets,
          });

          const targetResults: Partial<Record<HueRuntimeTarget, HueTargetCommandResult>> = {};
          for (const target of runtimePlan.stopTargets) {
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
          }

          const merged = applyRuntimeResultToTargets(runtimePlan, targetResults);
          setActiveOutputTargets(merged.activeTargets);
          setLightingModeState(normalizedNextMode);
          await saveShellState({ lightingMode: normalizedNextMode });
          return;
        }

        const runtimePlan = resolveHueRuntimePlan({
          action: "start",
          selectedTargets: selectedOutputTargets,
          activeTargets: activeOutputTargets,
        });

        const targetResults: Partial<Record<HueRuntimeTarget, HueTargetCommandResult>> = {};
        for (const target of runtimePlan.startTargets) {
          if (target === "usb") {
            await setLightingMode(normalizedNextMode);
            targetResults.usb = { ok: true };
          }

          if (target === "hue") {
            if (!hueStartConfig) {
              targetResults.hue = {
                ok: false,
                code: "CONFIG_NOT_READY_GATE_BLOCKED",
                message: "Hue start requires bridge, credential, and area configuration.",
              };
              continue;
            }

            const hueResult = await startHue(hueStartConfig);
            targetResults.hue = {
              ok: isHueStartCodeOk(hueResult.status.code),
              code: hueResult.status.code,
              message: hueResult.status.message,
            };
          }
        }

        const merged = applyRuntimeResultToTargets(runtimePlan, targetResults);
        setActiveOutputTargets(merged.activeTargets);
        if (merged.activeTargets.length > 0) {
          setLightingModeState(normalizedNextMode);
          await saveShellState({ lightingMode: normalizedNextMode });
        }
      } catch (error) {
        const modeLabel = normalizedNextMode.kind;
        console.error(`[LumaSync] Failed to switch lighting mode to ${modeLabel}:`, error);
      }
    },
    [activeOutputTargets, hueStartConfig, openCalibrationOverlay, savedCalibration, selectedOutputTargets],
  );

  const modeGuard = canEnableLedMode(savedCalibration);

  void lifecycleReady;

  return (
    <>
      <SettingsLayout
        activeSection={activeSection}
        onSectionChange={handleSectionChange}
        calibration={savedCalibration}
        lightingMode={lightingMode}
        outputTargets={selectedOutputTargets}
        modeLockReason={modeGuard.reason === MODE_GUARD_REASONS.CALIBRATION_REQUIRED ? modeGuard.reason : null}
        onLightingModeChange={handleLightingModeChange}
        onOutputTargetsChange={handleOutputTargetsChange}
        onEditCalibration={handleOpenCalibration}
      />
      <CalibrationOverlay
        open={overlayOpen}
        initialStep={overlayStep}
        initialConfig={savedCalibration}
        onClose={() => {
          setOverlayOpen(false);
        }}
        onSaved={(config) => {
          setSavedCalibration(config);
        }}
      />
    </>
  );
}

export default App;
