import { useState, memo } from "react";
import { SECTION_IDS, type SectionId, type UIMode } from "../../shared/contracts/shell";
import { LightsSection } from "./sections/LightsSection";
import { CalibrationPage } from "../calibration/ui/CalibrationPage";
import { DeviceSection } from "./sections/DeviceSection";
import { SystemSection } from "./sections/SystemSection";
import type { LedCalibrationConfig, LedSegmentCounts } from "../calibration/model/contracts";
import type { ModeGuardReason } from "../mode/state/modeGuard";
import type { LightingModeConfig } from "../mode/model/contracts";
import type { HueRuntimeTarget } from "../../shared/contracts/hue";
import type { UpdaterState } from "../updater/useAutoUpdater";
import { RoomMapEditor } from "./sections/RoomMapEditor";
import { resetToManual } from "../calibration/model/templates";
import { CompactLayout } from "./sections/compact/CompactLayout";


interface SettingsLayoutProps {
  uiMode: UIMode;
  activeSection: SectionId;
  onSectionChange: (sectionId: SectionId) => Promise<void>;
  calibration?: LedCalibrationConfig;
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
  onCheckForUpdates: () => void;
  isCheckingForUpdates: boolean;
  devSetUpdaterState?: (state: UpdaterState) => void;
}

export const SettingsLayout = memo(function SettingsLayout({
  uiMode,
  activeSection,
  onSectionChange,
  calibration,
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
  onCheckForUpdates,
  isCheckingForUpdates,
  devSetUpdaterState,
}: SettingsLayoutProps) {
  const [pendingZoneCounts, setPendingZoneCounts] = useState<LedSegmentCounts | null>(null);

  // ── Compact mode ──────────────────────────────────────────────────────
  if (uiMode === "compact") {
    return (
      <CompactLayout
        lightingMode={lightingMode}
        outputTargets={outputTargets}
        usbConnected={usbConnected}
        hueConfigured={hueConfigured}
        hueReachable={hueReachable}
        isModeTransitioning={isModeTransitioning}
        modeLockReason={modeLockReason}
        onLightingModeChange={onLightingModeChange}
      />
    );
  }

  // ── Full mode ─────────────────────────────────────────────────────────
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden" style={{ background: "var(--lm-bg)", color: "var(--lm-ink)" }}>
      {/* Main content */}
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden" role="main">
        {activeSection === SECTION_IDS.LIGHTS && (
          <div className="h-full overflow-hidden">
            <LightsSection
              mode={lightingMode}
              outputTargets={outputTargets}
              usbConnected={usbConnected}
              hueConfigured={hueConfigured}
              hueReachable={hueReachable}
              hueStreaming={hueStreaming}
              calibration={calibration}
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
          />
        )}

        {activeSection === SECTION_IDS.DEVICES && (
          <div className="h-full overflow-hidden">
            <DeviceSection />
          </div>
        )}

        {activeSection === SECTION_IDS.SYSTEM && (
          <div className="h-full overflow-hidden">
            <SystemSection
              onCheckForUpdates={onCheckForUpdates}
              isCheckingForUpdates={isCheckingForUpdates}
              devSetUpdaterState={devSetUpdaterState}
              usbConnected={usbConnected}
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
});
