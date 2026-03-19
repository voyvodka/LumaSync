/**
 * About / Logs Section
 *
 * Phase 1 baseline – App version info and log access.
 * Deferred features (auto-update) are explicitly excluded.
 */

export function AboutLogsSection() {
  return (
    <div className="settings-section">
      <h2 className="settings-section__title">About &amp; Logs</h2>

      <div className="settings-section__row">
        <div className="settings-section__row-label">
          <span className="settings-section__row-title">Ambilight</span>
          <span className="settings-section__row-desc">Version 0.1.0 (Phase 1)</span>
        </div>
      </div>

      <div className="settings-section__divider" />

      <div className="settings-section__row">
        <div className="settings-section__row-label">
          <span className="settings-section__row-title">Application logs</span>
          <span className="settings-section__row-desc">
            Diagnostic logs are stored locally and are not sent anywhere.
          </span>
        </div>
      </div>
    </div>
  );
}
