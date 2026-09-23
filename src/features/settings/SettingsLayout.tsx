import type { LocalSink } from "@/features/device/localSink";
import { useState, memo } from "react";
import { SECTION_IDS, type SectionId, type UIMode } from "@/shared/contracts/shell";
import { LightsSection } from "./sections/LightsSection";
import { CalibrationPage } from "../calibration/ui/CalibrationPage";
import { DeviceSection } from "./sections/DeviceSection";
import { SystemSection } from "./sections/SystemSection";
import type { LedCalibrationConfig, LedSegmentCounts } from "../calibration/model/contracts";
import type {
  ColorCorrectionConfig,
  FirmwareProfile,
  LedChipType,
  LedColorOrder,
} from "@/shared/contracts/device";
import type { ModeGuardReason } from "../mode/state/modeGuard";
import type { LightingModeConfig } from "../mode/model/contracts";
import type { HueIntensityPreset, HueRuntimeTarget } from "@/shared/contracts/hue";
import type { UpdaterState } from "../updater/useAutoUpdater";
import type { HueProbeVerdict } from "../hue/state/useHueBridgeReachability";
import { RoomMapEditor } from "@/features/room-map/ui/RoomMapEditor";
import { resetToManual } from "../calibration/model/templates";
import { CompactLayout } from "./sections/compact/CompactLayout";


interface SettingsLayoutProps {
  uiMode: UIMode;
  activeSection: SectionId;
  onSectionChange: (sectionId: SectionId) => Promise<void>;
  calibration?: LedCalibrationConfig;
  lightingMode: LightingModeConfig;
  outputTargets: HueRuntimeTarget[];
  /** The bound local output — serial strip or WLED panel — or `null` for none. */
  localSink: LocalSink | null;
  hueConfigured: boolean;
  hueReachable?: boolean;
  /** The Hue bridge probe stopped after a sustained outage; surfaces a retry in the offline banner. */
  hueProbeGaveUp?: boolean;
  hueProbeChecking?: boolean;
  hueProbeVerdict?: HueProbeVerdict | null;
  onRetryHueProbe?: () => void;
  hueStreaming: boolean;
  /** Hue session owned but the backend is retrying the bridge; overrides `hueStreaming`. */
  hueReconnecting?: boolean;
  modeLockReason: ModeGuardReason | null;
  isModeTransitioning?: boolean;
  onLightingModeChange: (nextMode: LightingModeConfig) => void;
  onOutputTargetsChange: (targets: HueRuntimeTarget[]) => void;
  onCalibrationSaved: (config: LedCalibrationConfig) => void;
  onCheckForUpdates: () => void;
  isCheckingForUpdates: boolean;
  devSetUpdaterState?: (state: UpdaterState) => void;
  /**
   * v1.4 G6 — forwarded to LightsSection so the user's Hue intensity preset
   * selection can hot-reload the running ambilight worker through the
   * shared shell helper in App.tsx. Optional so the compact-only path can
   * drop it without complaining.
   */
  onHueIntensityPresetChange?: (preset: HueIntensityPreset) => void;
  /**
   * v1.4 G4 — forwarded to LightsSection so color correction edits in the
   * ColorCorrectionPanel can hot-reload the running worker via
   * set_lighting_mode. Mirrors the onHueIntensityPresetChange pattern.
   */
  onColorCorrectionChange?: (next: ColorCorrectionConfig) => void;
  /**
   * v1.4 G11 — forwarded to LightsSection so firmware profile swaps in
   * the FirmwareProfilePicker can hot-reload the running encoder via
   * set_lighting_mode. Mirrors the onHueIntensityPresetChange pattern.
   */
  onFirmwareProfileChange?: (next: FirmwareProfile) => void;
  /** Forwarded to the chip-type picker in DEVICES; same hot-reload contract as
   *  `onFirmwareProfileChange`, because chip type is also a wire-format change. */
  onChipTypeChange?: (next: LedChipType) => void;
  /** Forwarded to the colour-order control in DEVICES; retuned in place, no force. */
  onColorOrderChange?: (next: LedColorOrder) => void;
  /** Forwarded to LED Setup's display picker. Without it a mid-session monitor
   *  switch persists but never reaches the running capture session. */
  onSelectedDisplayIdChange?: (next: string) => void;
  /**
   * v1.5 W2-B1 — compact-mode "no reachable output" banner deep-link.
   * Forwarded only when `uiMode === "compact"`; full mode renders its
   * own DEVICES section navigation through the sidebar.
   */
  onOpenDevices?: () => void;
}

export const SettingsLayout = memo(function SettingsLayout({
  uiMode,
  activeSection,
  onSectionChange,
  calibration,
  lightingMode,
  outputTargets,
  localSink,
  hueConfigured,
  hueReachable = true,
  hueProbeGaveUp = false,
  hueProbeChecking = false,
  hueProbeVerdict = null,
  onRetryHueProbe,
  hueStreaming,
  hueReconnecting = false,
  modeLockReason,
  isModeTransitioning = false,
  onLightingModeChange,
  onOutputTargetsChange,
  onCalibrationSaved,
  onCheckForUpdates,
  isCheckingForUpdates,
  devSetUpdaterState,
  onHueIntensityPresetChange,
  onColorCorrectionChange,
  onFirmwareProfileChange,
  onChipTypeChange,
  onColorOrderChange,
  onSelectedDisplayIdChange,
  onOpenDevices,
}: SettingsLayoutProps) {
  const localOutputConnected = localSink !== null;
  const [pendingZoneCounts, setPendingZoneCounts] = useState<LedSegmentCounts | null>(null);

  // ── Compact mode ──────────────────────────────────────────────────────
  if (uiMode === "compact") {
    return (
      <CompactLayout
        lightingMode={lightingMode}
        outputTargets={outputTargets}
        localOutputConnected={localOutputConnected}
        hueConfigured={hueConfigured}
        hueReachable={hueReachable}
        hueProbeGaveUp={hueProbeGaveUp}
        hueProbeChecking={hueProbeChecking}
        hueProbeVerdict={hueProbeVerdict}
        onRetryHueProbe={onRetryHueProbe}
        isModeTransitioning={isModeTransitioning}
        modeLockReason={modeLockReason}
        onLightingModeChange={onLightingModeChange}
        onOpenDevices={onOpenDevices}
        onHueIntensityPresetChange={onHueIntensityPresetChange}
      />
    );
  }

  // ── Full mode ─────────────────────────────────────────────────────────
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden" data-testid="full-layout" style={{ background: "var(--lm-bg)", color: "var(--lm-ink)" }}>
      {/* Main content */}
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden" role="main" data-testid={`section-panel-${activeSection}`}>
        {activeSection === SECTION_IDS.LIGHTS && (
          <div className="h-full overflow-hidden">
            <LightsSection
              mode={lightingMode}
              outputTargets={outputTargets}
              localOutputConnected={localOutputConnected}
              localSink={localSink}
              hueConfigured={hueConfigured}
              hueReachable={hueReachable}
              hueProbeGaveUp={hueProbeGaveUp}
              hueProbeChecking={hueProbeChecking}
              hueProbeVerdict={hueProbeVerdict}
              onRetryHueProbe={onRetryHueProbe}
              hueStreaming={hueStreaming}
              hueReconnecting={hueReconnecting}
              calibration={calibration}
              modeLockReason={modeLockReason}
              isModeTransitioning={isModeTransitioning}
              onModeChange={onLightingModeChange}
              onOutputTargetsChange={onOutputTargetsChange}
              onOpenCalibration={() => void onSectionChange(SECTION_IDS.LED_SETUP)}
              onOpenDevices={() => void onSectionChange(SECTION_IDS.DEVICES)}
              onHueIntensityPresetChange={onHueIntensityPresetChange}
              onColorCorrectionChange={onColorCorrectionChange}
              onFirmwareProfileChange={onFirmwareProfileChange}
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
            onDisplayChange={onSelectedDisplayIdChange}
          />
        )}

        {activeSection === SECTION_IDS.DEVICES && (
          <div className="h-full overflow-hidden">
            <DeviceSection
              onNavigateToRoomMap={() => void onSectionChange(SECTION_IDS.ROOM_MAP)}
              onChipTypeChange={onChipTypeChange}
              onColorOrderChange={onColorOrderChange}
            />
          </div>
        )}

        {activeSection === SECTION_IDS.SYSTEM && (
          <div className="h-full overflow-hidden">
            <SystemSection
              onCheckForUpdates={onCheckForUpdates}
              isCheckingForUpdates={isCheckingForUpdates}
              devSetUpdaterState={devSetUpdaterState}
              localOutputConnected={localOutputConnected}
            />
          </div>
        )}

        {activeSection === SECTION_IDS.ROOM_MAP && (
          <div className="h-full overflow-hidden">
            <RoomMapEditor
              onZoneCountsConfirmed={setPendingZoneCounts}
              onNavigateToDevices={() => void onSectionChange(SECTION_IDS.DEVICES)}
              hueReachable={hueReachable}
              outputTargets={outputTargets}
              hueConfigured={hueConfigured}
              hueProbeVerdict={hueProbeVerdict}
            />
          </div>
        )}

      </main>
    </div>
  );
});
