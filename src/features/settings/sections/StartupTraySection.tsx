/**
 * Startup / Tray Section
 *
 * Phase 1 baseline – Controls startup-at-login and tray behavior.
 * Wires to trayController for autostart toggle.
 */

import { useState, useEffect } from "react";
import { toggleStartup, getStartupEnabled, listenStartupToggle } from "../../tray/trayController";

export function StartupTraySection() {
  const [startupEnabled, setStartupEnabled] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    // Read current autostart state on mount
    let unlistenFn: (() => void) | null = null;

    async function init() {
      try {
        const enabled = await getStartupEnabled();
        setStartupEnabled(enabled);
      } catch {
        // Autostart plugin may not be available in dev mode – default to false
        setStartupEnabled(false);
      } finally {
        setLoading(false);
      }

      // Listen for tray menu startup-toggle clicks so UI stays in sync
      try {
        unlistenFn = await listenStartupToggle((newState) => {
          setStartupEnabled(newState);
        });
      } catch {
        // Non-fatal – UI toggle still works
      }
    }

    init();

    return () => {
      unlistenFn?.();
    };
  }, []);

  async function handleToggle() {
    try {
      const newState = await toggleStartup();
      setStartupEnabled(newState);
    } catch {
      // Handle gracefully – button state unchanged
    }
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Startup &amp; Tray</h2>
      <div className="settings-section__row">
        <div className="settings-section__row-label">
          <span className="settings-section__row-title">Launch at login</span>
          <span className="settings-section__row-desc">
            Start Ambilight automatically when you log in.
          </span>
        </div>
        <button
          className={`settings-toggle ${startupEnabled ? "settings-toggle--on" : "settings-toggle--off"}`}
          onClick={handleToggle}
          disabled={loading}
          aria-pressed={startupEnabled}
          aria-label="Toggle launch at login"
        >
          <span className="settings-toggle__thumb" />
        </button>
      </div>

      <div className="settings-section__row">
        <div className="settings-section__row-label">
          <span className="settings-section__row-title">Minimize to tray on close</span>
          <span className="settings-section__row-desc">
            Closing the window keeps Ambilight running in the system tray.
          </span>
        </div>
        <span className="settings-section__row-badge">Always on</span>
      </div>
    </div>
  );
}
