import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SECTION_IDS, SECTION_ORDER, type SectionId } from "../../shared/contracts/shell";
import { GeneralSection } from "./sections/GeneralSection";
import { CalibrationPage } from "../calibration/ui/CalibrationPage";
import { DeviceSection } from "./sections/DeviceSection";
import { SystemSection } from "./sections/SystemSection";
import type { LedCalibrationConfig, LedSegmentCounts } from "../calibration/model/contracts";
import type { ModeGuardReason } from "../mode/state/modeGuard";
import type { LightingModeConfig } from "../mode/model/contracts";
import type { HueRuntimeTarget } from "../../shared/contracts/hue";
import type { CalibrationOverlayStep } from "../calibration/state/entryFlow";
import { APP_NAME, APP_VERSION } from "../../shared/constants/app";
import { RoomMapEditor } from "./sections/RoomMapEditor";
import { resetToManual } from "../calibration/model/templates";
import { SidebarFpsWidget } from "../telemetry/ui/SidebarFpsWidget";

// Nav icons
function IconLights() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="10" r="3" />
      <path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.05 5.05l1.41 1.41M13.54 13.54l1.41 1.41M5.05 14.95l1.41-1.41M13.54 6.46l1.41-1.41" />
    </svg>
  );
}

function IconLedSetup() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="16" height="11" rx="1.5" />
      <path d="M7 17h6M10 15v2" />
      <path d="M5 7h4M5 10h6M5 13h3" />
    </svg>
  );
}

function IconDevices() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 4v5M13.5 4v5M4 9h12v3.5a6 6 0 01-12 0V9z" />
      <path d="M10 16v2" />
    </svg>
  );
}

function IconSystem() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.4 4.4l1.4 1.4M14.2 14.2l1.4 1.4M4.4 15.6l1.4-1.4M14.2 5.8l1.4-1.4" />
    </svg>
  );
}

function IconRoomMap() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="16" height="16" rx="1.5" />
      <path d="M2 7h16M7 7v11" />
    </svg>
  );
}

const NAV_ICONS: Record<SectionId, React.ReactNode> = {
  [SECTION_IDS.LIGHTS]: <IconLights />,
  [SECTION_IDS.LED_SETUP]: <IconLedSetup />,
  [SECTION_IDS.DEVICES]: <IconDevices />,
  [SECTION_IDS.SYSTEM]: <IconSystem />,
  [SECTION_IDS.ROOM_MAP]: <IconRoomMap />,
};

interface SettingsLayoutProps {
  activeSection: SectionId;
  onSectionChange: (sectionId: SectionId) => Promise<void>;
  calibration?: LedCalibrationConfig;
  calibrationStep: CalibrationOverlayStep;
  lightingMode: LightingModeConfig;
  outputTargets: HueRuntimeTarget[];
  usbConnected: boolean;
  hueConfigured: boolean;
  hueReachable?: boolean;
  hueStreaming: boolean;
  modeLockReason: ModeGuardReason | null;
  isModeTransitioning?: boolean;
  onLightingModeChange: (nextMode: LightingModeConfig) => void;
  onOutputTargetsChange: (targets: HueRuntimeTarget[]) => void;
  onCalibrationSaved: (config: LedCalibrationConfig) => void;
  onCalibrationStepChange: (step: CalibrationOverlayStep) => void;
  onCheckForUpdates: () => void;
  isCheckingForUpdates: boolean;
}

export function SettingsLayout({
  activeSection,
  onSectionChange,
  calibration,
  calibrationStep,
  lightingMode,
  outputTargets,
  usbConnected,
  hueConfigured,
  hueReachable = true,
  hueStreaming,
  modeLockReason,
  isModeTransitioning = false,
  onLightingModeChange,
  onOutputTargetsChange,
  onCalibrationSaved,
  onCalibrationStepChange,
  onCheckForUpdates,
  isCheckingForUpdates,
}: SettingsLayoutProps) {
  const { t } = useTranslation("common");
  const [pendingZoneCounts, setPendingZoneCounts] = useState<LedSegmentCounts | null>(null);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-100/60 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Sidebar */}
      <nav
        className="flex w-48 min-w-[160px] flex-col border-r border-slate-200/70 bg-white/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/80"
        aria-label={t("settings.navigationAria")}
      >
        {/* App name */}
        <div className="border-b border-slate-200/70 px-4 py-4 dark:border-zinc-800">
          <span className="text-[11px] font-bold tracking-[0.18em] text-slate-500 uppercase dark:text-zinc-400">
            {APP_NAME}
          </span>
        </div>

        {/* Nav items */}
        <ul className="flex flex-1 flex-col gap-0.5 p-2" role="list">
          {SECTION_ORDER.map((sectionId) => {
            const isActive = sectionId === activeSection;
            const label = t(`settings.sections.${sectionId}`);
            return (
              <li key={sectionId}>
                <button
                  className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900 ${
                    isActive
                      ? "bg-slate-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                  }`}
                  onClick={() => void onSectionChange(sectionId)}
                  aria-current={isActive ? "page" : undefined}
                >
                  <span
                    className={`shrink-0 ${
                      isActive ? "text-white dark:text-zinc-900" : "text-slate-500 dark:text-zinc-400"
                    }`}
                  >
                    {NAV_ICONS[sectionId]}
                  </span>
                  <span>{label}</span>
                </button>
              </li>
            );
          })}
        </ul>

        {/* Debug: FPS widget — dev builds only */}
        {import.meta.env.DEV && <SidebarFpsWidget />}

        {/* Version */}
        <div className="border-t border-slate-200/70 px-4 py-3 dark:border-zinc-800">
          <span className="text-[10px] tabular-nums text-slate-400 dark:text-zinc-600">
            v{APP_VERSION}
          </span>
        </div>
      </nav>

      {/* Main content */}
      <main className="min-w-0 flex-1 overflow-hidden" role="main">
        {activeSection === SECTION_IDS.LIGHTS && (
          <div className="h-full overflow-y-auto overscroll-contain px-6 py-6">
            <GeneralSection
              mode={lightingMode}
              outputTargets={outputTargets}
              usbConnected={usbConnected}
              hueConfigured={hueConfigured}
              hueReachable={hueReachable}
              hueStreaming={hueStreaming}
              modeLockReason={modeLockReason}
              isModeTransitioning={isModeTransitioning}
              onModeChange={onLightingModeChange}
              onOutputTargetsChange={onOutputTargetsChange}
              onOpenCalibration={() => void onSectionChange(SECTION_IDS.LED_SETUP)}
            />
          </div>
        )}

        {activeSection === SECTION_IDS.LED_SETUP && (
          <CalibrationPage
            key="calibration-page"
            initialStep={calibrationStep}
            initialConfig={
              pendingZoneCounts
                ? { ...(calibration ?? resetToManual()), counts: pendingZoneCounts }
                : calibration
            }
            onNavigateBack={() => {
              setPendingZoneCounts(null);
              void onSectionChange(SECTION_IDS.LIGHTS);
            }}
            onSaved={(cfg) => {
              setPendingZoneCounts(null);
              onCalibrationSaved(cfg);
            }}
            onStepChange={onCalibrationStepChange}
          />
        )}

        {activeSection === SECTION_IDS.DEVICES && (
          <div className="h-full overflow-y-auto overscroll-contain px-6 py-6">
            <DeviceSection />
          </div>
        )}

        {activeSection === SECTION_IDS.SYSTEM && (
          <div className="h-full overflow-y-auto overscroll-contain">
            <SystemSection
              onCheckForUpdates={onCheckForUpdates}
              isCheckingForUpdates={isCheckingForUpdates}
            />
          </div>
        )}

        {activeSection === SECTION_IDS.ROOM_MAP && (
          <div className="h-full overflow-hidden">
            <RoomMapEditor onZoneCountsConfirmed={setPendingZoneCounts} />
          </div>
        )}

      </main>
    </div>
  );
}
