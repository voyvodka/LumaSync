/**
 * Settings Layout
 *
 * Phase 1 settings shell scaffold: sidebar + content area.
 *
 * - Sidebar navigation with Phase 1 baseline sections
 * - No-reload SPA routing (section state in React)
 * - Section state is owned by App shell which persists lastSection to shellStore
 * - "Language" slot is present in navigation but content is implemented in Plan 02
 */

import { SECTION_IDS, SECTION_ORDER, type SectionId } from "../../shared/contracts/shell";
import { GeneralSection } from "./sections/GeneralSection";
import { StartupTraySection } from "./sections/StartupTraySection";
import { LanguageSection } from "./sections/LanguageSection";
import { AboutLogsSection } from "./sections/AboutLogsSection";
import { DeviceSection } from "./sections/DeviceSection";
import "./SettingsLayout.css";

// ---------------------------------------------------------------------------
// Sidebar metadata
// ---------------------------------------------------------------------------

interface SectionMeta {
  id: SectionId;
  label: string;
  icon: string;
}

const SECTION_META: Record<SectionId, SectionMeta> = {
  [SECTION_IDS.GENERAL]: { id: SECTION_IDS.GENERAL, label: "General", icon: "⚙️" },
  [SECTION_IDS.STARTUP_TRAY]: { id: SECTION_IDS.STARTUP_TRAY, label: "Startup & Tray", icon: "🚀" },
  [SECTION_IDS.LANGUAGE]: { id: SECTION_IDS.LANGUAGE, label: "Language", icon: "🌐" },
  [SECTION_IDS.ABOUT_LOGS]: { id: SECTION_IDS.ABOUT_LOGS, label: "About & Logs", icon: "ℹ️" },
  [SECTION_IDS.DEVICE]: { id: SECTION_IDS.DEVICE, label: "Device", icon: "🔌" },
};

// ---------------------------------------------------------------------------
// Section content renderer
// ---------------------------------------------------------------------------

function SectionContent({ sectionId }: { sectionId: SectionId }) {
  switch (sectionId) {
    case SECTION_IDS.GENERAL:
      return <GeneralSection />;
    case SECTION_IDS.STARTUP_TRAY:
      return <StartupTraySection />;
    case SECTION_IDS.LANGUAGE:
      return <LanguageSection />;
    case SECTION_IDS.ABOUT_LOGS:
      return <AboutLogsSection />;
    case SECTION_IDS.DEVICE:
      return <DeviceSection />;
    default:
      return <GeneralSection />;
  }
}

// ---------------------------------------------------------------------------
// SettingsLayout
// ---------------------------------------------------------------------------

interface SettingsLayoutProps {
  /** Currently active section (controlled by App shell for persistence) */
  activeSection: SectionId;
  /** Called when user clicks a sidebar item */
  onSectionChange: (sectionId: SectionId) => void;
}

export function SettingsLayout({ activeSection, onSectionChange }: SettingsLayoutProps) {
  return (
    <div className="settings-shell">
      {/* Sidebar */}
      <nav className="settings-sidebar" aria-label="Settings navigation">
        <div className="settings-sidebar__header">
          <span className="settings-sidebar__app-name">Ambilight</span>
        </div>
        <ul className="settings-sidebar__nav" role="list">
          {SECTION_ORDER.map((sectionId) => {
            const meta = SECTION_META[sectionId];
            const isActive = sectionId === activeSection;
            return (
              <li key={sectionId}>
                <button
                  className={`settings-sidebar__item ${isActive ? "settings-sidebar__item--active" : ""}`}
                  onClick={() => onSectionChange(sectionId)}
                  aria-current={isActive ? "page" : undefined}
                >
                  <span className="settings-sidebar__item-icon" aria-hidden="true">
                    {meta.icon}
                  </span>
                  <span className="settings-sidebar__item-label">{meta.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Content area */}
      <main className="settings-content" role="main">
        <SectionContent sectionId={activeSection} />
      </main>
    </div>
  );
}
