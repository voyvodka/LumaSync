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

import { useState, useEffect, useCallback } from "react";
import { SettingsLayout } from "./features/settings/SettingsLayout";
import { CalibrationOverlay } from "./features/calibration/ui/CalibrationOverlay";
import {
  deriveCalibrationOverlayEntry,
  startCalibrationFromSettings,
  type CalibrationOverlayStep,
} from "./features/calibration/state/entryFlow";
import type { LedCalibrationConfig } from "./features/calibration/model/contracts";
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
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayStep, setOverlayStep] = useState<CalibrationOverlayStep>("editor");
  const [lifecycleReady, setLifecycleReady] = useState(false);

  useEffect(() => {
    async function bootstrap() {
      try {
        const state = await loadShellState();
        setActiveSection(state.lastSection);
        setSavedCalibration(state.ledCalibration);

        const entry = deriveCalibrationOverlayEntry({
          hasConnectedDevice: Boolean(state.lastSuccessfulPort),
          savedCalibration: state.ledCalibration,
        });
        if (entry.open) {
          setOverlayStep(entry.step);
          setOverlayOpen(true);
        }

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

  const handleOpenCalibration = useCallback(() => {
    const entry = startCalibrationFromSettings(savedCalibration);
    setOverlayStep(entry.step);
    setOverlayOpen(entry.open);
  }, [savedCalibration]);

  void lifecycleReady;

  return (
    <>
      <SettingsLayout
        activeSection={activeSection}
        onSectionChange={handleSectionChange}
        calibration={savedCalibration}
        onOpenCalibration={handleOpenCalibration}
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
