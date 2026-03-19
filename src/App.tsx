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
 *  - Defers i18n provider to Plan 02 (placeholder pass-through for now)
 */

import { useState, useEffect, useCallback } from "react";
import "./App.css";
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

  // -------------------------------------------------------------------------
  // Bootstrap: restore shell state and init window lifecycle
  // -------------------------------------------------------------------------

  useEffect(() => {
    async function bootstrap() {
      try {
        // 1. Load persisted shell state for section restore
        const state = await loadShellState();
        setActiveSection(state.lastSection);

        // 2. Init window lifecycle: restore geometry, register close-to-tray hint
        await initWindowLifecycle({
          onFirstClosToTray: () => {
            // Phase 1: hint is a console note; Phase 2+ can surface a toast here
            console.info(
              "[Ambilight] Hint: The app is still running in the system tray. " +
                "Click the tray icon to reopen settings."
            );
          },
        });
      } catch (err) {
        // Non-fatal: bootstrap continues with defaults if store is unavailable (e.g., dev without Tauri)
        console.warn("[Ambilight] Shell lifecycle bootstrap error:", err);
      } finally {
        setLifecycleReady(true);
      }
    }

    bootstrap();
  }, []);

  // -------------------------------------------------------------------------
  // Section change handler — persist last section on every navigation
  // -------------------------------------------------------------------------

  const handleSectionChange = useCallback(async (sectionId: SectionId) => {
    setActiveSection(sectionId);
    try {
      await saveShellState({ lastSection: sectionId });
    } catch {
      // Non-fatal: navigation works even if persistence fails
    }
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Avoid layout shift: render shell immediately with default section,
  // then update once persisted state is loaded (state update is fast).
  // `lifecycleReady` is tracked but not used as a gate to avoid flash.
  void lifecycleReady;

  return (
    <SettingsLayout
      activeSection={activeSection}
      onSectionChange={handleSectionChange}
    />
  );
}

export default App;
