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
  const [lifecycleReady, setLifecycleReady] = useState(false);

  useEffect(() => {
    async function bootstrap() {
      try {
        const state = await loadShellState();
        setActiveSection(state.lastSection);

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

  void lifecycleReady;

  return (
    <SettingsLayout
      activeSection={activeSection}
      onSectionChange={handleSectionChange}
    />
  );
}

export default App;
