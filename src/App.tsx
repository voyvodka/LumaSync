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
  stopLighting,
} from "./features/mode/modeApi";
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

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>(SECTION_IDS.GENERAL);
  const [savedCalibration, setSavedCalibration] = useState<LedCalibrationConfig | undefined>(undefined);
  const [lightingMode, setLightingModeState] = useState<LightingModeConfig>({ kind: LIGHTING_MODE_KIND.OFF });
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
        setLightingModeState(normalizeLightingModeConfig(state.lightingMode));

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
          await stopLighting();
        } else {
          await setLightingMode(normalizedNextMode);
        }

        setLightingModeState(normalizedNextMode);

        await saveShellState({ lightingMode: normalizedNextMode });
      } catch (error) {
        const modeLabel = normalizedNextMode.kind;
        console.error(`[LumaSync] Failed to switch lighting mode to ${modeLabel}:`, error);
      }
    },
    [openCalibrationOverlay, savedCalibration],
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
        modeLockReason={modeGuard.reason === MODE_GUARD_REASONS.CALIBRATION_REQUIRED ? modeGuard.reason : null}
        onLightingModeChange={handleLightingModeChange}
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
