import { useState, memo, useEffect, useCallback, Suspense } from "react";
import { SECTION_IDS, type UIMode } from "@/shared/contracts/shell";
import { preloadableComponent } from "@/shared/lib/preloadableComponent";
import { shallowEqual } from "@/shared/lib/store";
import { LightsSection } from "./sections/LightsSection";
import { SystemSection } from "./sections/SystemSection";
import type { LedSegmentCounts } from "../calibration/model/contracts";
import {
  useLightingActions,
  useLightingControlState,
  type LightingControlState,
} from "../mode/state/lightingControl";
import { useNavigationActions, useNavigationState, type NavigationState } from "../shell/navigationStore";
import { useUpdaterActions, useUpdaterState, type UpdaterSnapshot } from "../updater/UpdaterProvider";
import type { HueProbeVerdict } from "../hue/state/useHueBridgeReachability";
import { resetToManual } from "../calibration/model/templates";
import { CompactLayout } from "./sections/compact/CompactLayout";
import type { RoomMapEditorProps } from "@/features/room-map/ui/RoomMapEditor";

// The three full-only sections that each outweigh the rest of the shell are
// split out, so the compact window never parses them. See
// docs/architecture/ui-and-shell.md, "Per-window bundles".
const CalibrationPage = preloadableComponent("CalibrationPage", () =>
  import("../calibration/ui/CalibrationPage").then((m) => m.CalibrationPage),
);
const DeviceSection = preloadableComponent("DeviceSection", () =>
  import("./sections/DeviceSection").then((m) => m.DeviceSection),
);
const RoomMapEditor = preloadableComponent<RoomMapEditorProps>("RoomMapEditor", () =>
  import("@/features/room-map/ui/RoomMapEditor").then((m) => m.RoomMapEditor),
);
const FULL_ONLY_SECTIONS = [CalibrationPage, DeviceSection, RoomMapEditor];

/** Warms the full-only chunks once full mode has painted, so a tab switch rarely meets the fallback. */
function useFullOnlySectionPreload(uiMode: UIMode) {
  useEffect(() => {
    if (uiMode !== "full") return;
    const preloadAll = () => {
      for (const section of FULL_ONLY_SECTIONS) section.preload();
    };
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(preloadAll, { timeout: 1000 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(preloadAll, 200);
    return () => window.clearTimeout(handle);
  }, [uiMode]);
}

/** Blank on purpose: a local chunk resolves in milliseconds, and a spinner would only flash. */
function SectionPlaceholder() {
  return <div className="h-full" aria-busy="true" data-testid="section-loading" />;
}

/**
 * The Hue status the shell derives from its polls. Still props: the Hue
 * health store that replaces those polls will replace these too.
 */
export interface SettingsLayoutProps {
  hueConfigured: boolean;
  hueReachable?: boolean;
  hueProbeVerdict?: HueProbeVerdict | null;
  hueStreaming: boolean;
  /** Hue session owned but the backend is retrying the bridge; overrides `hueStreaming`. */
  hueReconnecting?: boolean;
  hueStreamFailed?: boolean;
}

// Every panel below is memoised and reads its own slices, so a change only one
// of them shows re-renders that one alone. See docs/architecture/ui-and-shell.md,
// "Shell state reaches sections through stores".

const selectLayoutNavigation = (state: NavigationState) => ({
  uiMode: state.uiMode,
  activeSection: state.activeSection,
});

const selectLighting = (state: LightingControlState) => state;

const LightsPanel = memo(function LightsPanel({
  hueConfigured,
  hueReachable,
  hueProbeVerdict,
  hueStreaming,
  hueReconnecting,
  hueStreamFailed,
}: Required<SettingsLayoutProps>) {
  const lighting = useLightingControlState(selectLighting);
  const { changeMode, changeOutputTargets } = useLightingActions();
  return (
    <div className="h-full overflow-hidden">
      <LightsSection
        mode={lighting.lightingMode}
        outputTargets={lighting.outputTargets}
        localOutputConnected={lighting.localSink !== null}
        localSink={lighting.localSink}
        hueConfigured={hueConfigured}
        bootstrapDone={lighting.bootstrapDone}
        hueReachable={hueReachable}
        hueProbeVerdict={hueProbeVerdict}
        hueStreaming={hueStreaming}
        hueReconnecting={hueReconnecting}
        hueStreamFailed={hueStreamFailed}
        calibration={lighting.calibration}
        modeLockReason={lighting.modeLockReason}
        isModeTransitioning={lighting.isModeTransitioning}
        onModeChange={changeMode}
        onOutputTargetsChange={changeOutputTargets}
      />
    </div>
  );
});

const selectCalibration = (state: LightingControlState) => state.calibration;

const CalibrationPanel = memo(function CalibrationPanel({
  pendingZoneCounts,
  onPendingZoneCountsChange,
}: {
  pendingZoneCounts: LedSegmentCounts | null;
  onPendingZoneCountsChange: (counts: LedSegmentCounts | null) => void;
}) {
  const calibration = useLightingControlState(selectCalibration);
  const { saveCalibration } = useLightingActions();
  const { goToSection } = useNavigationActions();
  return (
    <CalibrationPage.Component
      initialConfig={
        pendingZoneCounts
          ? { ...(calibration ?? resetToManual()), counts: pendingZoneCounts }
          : calibration
      }
      onNavigateBack={() => {
        onPendingZoneCountsChange(null);
        void goToSection(SECTION_IDS.LIGHTS);
      }}
      onSaved={(cfg) => {
        onPendingZoneCountsChange(null);
        saveCalibration(cfg);
      }}
    />
  );
});

const selectDeviceCategoryRequest = (state: NavigationState) => state.deviceCategoryRequest;

const DevicesPanel = memo(function DevicesPanel() {
  const categoryRequest = useNavigationState(selectDeviceCategoryRequest);
  const { goToSection } = useNavigationActions();
  const { stopHueOutput } = useLightingActions();
  const openRoomMap = useCallback(() => void goToSection(SECTION_IDS.ROOM_MAP), [goToSection]);
  return (
    <div className="h-full overflow-hidden">
      <DeviceSection.Component
        onNavigateToRoomMap={openRoomMap}
        onStopHueOutput={stopHueOutput}
        categoryRequest={categoryRequest}
      />
    </div>
  );
});

const selectLocalOutputConnected = (state: LightingControlState) => state.localSink !== null;
const selectCheckingForUpdates = (snapshot: UpdaterSnapshot) => snapshot.state.status === "checking";

const SystemPanel = memo(function SystemPanel() {
  const localOutputConnected = useLightingControlState(selectLocalOutputConnected);
  const isCheckingForUpdates = useUpdaterState(selectCheckingForUpdates);
  const { checkForUpdates, devSetState } = useUpdaterActions();
  return (
    <div className="h-full overflow-hidden">
      <SystemSection
        onCheckForUpdates={checkForUpdates}
        isCheckingForUpdates={isCheckingForUpdates}
        devSetUpdaterState={devSetState}
        localOutputConnected={localOutputConnected}
      />
    </div>
  );
});

const selectOutputTargets = (state: LightingControlState) => state.outputTargets;

const RoomMapPanel = memo(function RoomMapPanel({
  hueReachable,
  hueConfigured,
  hueProbeVerdict,
  onZoneCountsConfirmed,
}: {
  hueReachable: boolean;
  hueConfigured: boolean;
  hueProbeVerdict: HueProbeVerdict | null;
  onZoneCountsConfirmed: (counts: LedSegmentCounts) => void;
}) {
  const outputTargets = useLightingControlState(selectOutputTargets);
  const { goToSection } = useNavigationActions();
  const openDevices = useCallback(() => void goToSection(SECTION_IDS.DEVICES), [goToSection]);
  return (
    <div className="h-full overflow-hidden">
      <RoomMapEditor.Component
        onZoneCountsConfirmed={onZoneCountsConfirmed}
        onNavigateToDevices={openDevices}
        hueReachable={hueReachable}
        outputTargets={outputTargets}
        hueConfigured={hueConfigured}
        hueProbeVerdict={hueProbeVerdict}
      />
    </div>
  );
});

export const SettingsLayout = memo(function SettingsLayout({
  hueConfigured,
  hueReachable = true,
  hueProbeVerdict = null,
  hueStreaming,
  hueReconnecting = false,
  hueStreamFailed = false,
}: SettingsLayoutProps) {
  const { uiMode, activeSection } = useNavigationState(selectLayoutNavigation, shallowEqual);
  const [pendingZoneCounts, setPendingZoneCounts] = useState<LedSegmentCounts | null>(null);
  useFullOnlySectionPreload(uiMode);

  // ── Compact mode ──────────────────────────────────────────────────────
  if (uiMode === "compact") {
    return (
      <CompactLayout
        hueConfigured={hueConfigured}
        hueReachable={hueReachable}
        hueProbeVerdict={hueProbeVerdict}
      />
    );
  }

  // ── Full mode ─────────────────────────────────────────────────────────
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden" data-testid="full-layout" style={{ background: "var(--lm-bg)", color: "var(--lm-ink)" }}>
      {/* Main content */}
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden" role="main" data-testid={`section-panel-${activeSection}`}>
        <Suspense fallback={<SectionPlaceholder />}>
          {activeSection === SECTION_IDS.LIGHTS && (
            <LightsPanel
              hueConfigured={hueConfigured}
              hueReachable={hueReachable}
              hueProbeVerdict={hueProbeVerdict}
              hueStreaming={hueStreaming}
              hueReconnecting={hueReconnecting}
              hueStreamFailed={hueStreamFailed}
            />
          )}

          {activeSection === SECTION_IDS.LED_SETUP && (
            <CalibrationPanel
              key="calibration-page"
              pendingZoneCounts={pendingZoneCounts}
              onPendingZoneCountsChange={setPendingZoneCounts}
            />
          )}

          {activeSection === SECTION_IDS.DEVICES && <DevicesPanel />}

          {activeSection === SECTION_IDS.SYSTEM && <SystemPanel />}

          {activeSection === SECTION_IDS.ROOM_MAP && (
            <RoomMapPanel
              hueReachable={hueReachable}
              hueConfigured={hueConfigured}
              hueProbeVerdict={hueProbeVerdict}
              onZoneCountsConfirmed={setPendingZoneCounts}
            />
          )}
        </Suspense>
      </main>
    </div>
  );
});
