import { useState, memo, useEffect, useCallback, Suspense, type ReactNode } from "react";
import { SECTION_IDS, SECTION_ORDER, type SectionId, type UIMode } from "@/shared/contracts/shell";
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
import {
  useLeaveGuardRegistrar,
  useNavigationActions,
  useNavigationState,
  useVisibleDeviceCategoryReporter,
  type NavigationState,
} from "../shell/navigationStore";
import { useUpdaterActions, useUpdaterState, type UpdaterSnapshot } from "../updater/UpdaterProvider";
import { useHueShellStatus, type HueShellStatus } from "../hue/state/hueShellStatus";
import { useSetupGuideActions } from "../onboarding/state/setupGuideControl";
import { syncStripLedCount } from "./sections/device/usbStripRoster";
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

/** Warms the full-only chunks once full mode has painted, so a tab switch rarely meets the fallback. */
function useFullOnlySectionPreload(uiMode: UIMode) {
  useEffect(() => {
    if (uiMode !== "full") return;
    const preloadAll = () => {
      for (const id of SECTION_ORDER) sectionEntry(id).preload?.();
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

// Every panel below is memoised and reads its own slices, so a change only one
// of them shows re-renders that one alone. See docs/architecture/ui-and-shell.md,
// "Shell state reaches sections through stores".

const selectLayoutNavigation = (state: NavigationState) => ({
  uiMode: state.uiMode,
  activeSection: state.activeSection,
});

const selectLighting = (state: LightingControlState) => state;
const selectHue = (status: HueShellStatus) => status;

const LightsPanel = memo(function LightsPanel() {
  const lighting = useLightingControlState(selectLighting);
  const hue = useHueShellStatus(selectHue);
  const { changeMode, changeOutputTargets } = useLightingActions();
  const { goToSection } = useNavigationActions();
  const openDevices = useCallback(() => void goToSection(SECTION_IDS.DEVICES), [goToSection]);
  return (
    <div className="h-full overflow-hidden">
      <LightsSection
        mode={lighting.lightingMode}
        outputTargets={lighting.outputTargets}
        localOutputConnected={lighting.localSink !== null}
        localSink={lighting.localSink}
        hueConfigured={hue.configured}
        bootstrapDone={lighting.bootstrapDone}
        hueReachable={hue.reachable}
        hueProbeVerdict={hue.probeVerdict}
        hueStreaming={hue.streaming}
        hueReconnecting={hue.reconnecting}
        hueStreamFailed={hue.streamFailed}
        calibration={lighting.calibration}
        modeLockReason={lighting.modeLockReason}
        isModeTransitioning={lighting.isModeTransitioning}
        onModeChange={changeMode}
        onOutputTargetsChange={changeOutputTargets}
        onAddOutput={openDevices}
      />
    </div>
  );
});

const selectCalibration = (state: LightingControlState) => state.calibration;
const selectSerialPort = (state: LightingControlState) =>
  state.localSink?.transport === "serial" ? state.localSink.id || null : null;

const CalibrationPanel = memo(function CalibrationPanel({
  pendingZoneCounts,
  onPendingZoneCountsChange,
}: {
  pendingZoneCounts: LedSegmentCounts | null;
  onPendingZoneCountsChange: (counts: LedSegmentCounts | null) => void;
}) {
  const calibration = useLightingControlState(selectCalibration);
  const serialPort = useLightingControlState(selectSerialPort);
  const { saveCalibration } = useLightingActions();
  const { goToSection } = useNavigationActions();
  const registerLeaveGuard = useLeaveGuardRegistrar();
  // Read once: the page takes them as its opening draft, and they must not come
  // back on the next visit after the user has saved or discarded them.
  const [draftCounts] = useState(pendingZoneCounts);
  useEffect(() => {
    if (draftCounts) onPendingZoneCountsChange(null);
  }, [draftCounts, onPendingZoneCountsChange]);
  return (
    <CalibrationPage.Component
      initialConfig={calibration}
      draftCounts={draftCounts}
      registerLeaveGuard={registerLeaveGuard}
      onNavigateBack={() => {
        void goToSection(SECTION_IDS.LIGHTS);
      }}
      onSaved={(cfg) => {
        saveCalibration(cfg);
        void syncStripLedCount(cfg.totalLeds, serialPort).catch((error) => {
          console.error("[LumaSync] Room map strip LED count could not follow the saved layout:", error);
        });
      }}
    />
  );
});

const selectDeviceCategoryRequest = (state: NavigationState) => state.deviceCategoryRequest;
const selectHueActive = (status: HueShellStatus) => status.configured && status.streaming;
const selectAmbilightActive = (state: LightingControlState) => state.lightingMode.kind === "ambilight";

const DevicesPanel = memo(function DevicesPanel() {
  const categoryRequest = useNavigationState(selectDeviceCategoryRequest);
  const hueActive = useHueShellStatus(selectHueActive);
  const ambilightActive = useLightingControlState(selectAmbilightActive);
  const reportVisibleCategory = useVisibleDeviceCategoryReporter();
  const { goToSection } = useNavigationActions();
  const { stopHueOutput } = useLightingActions();
  const openRoomMap = useCallback(() => void goToSection(SECTION_IDS.ROOM_MAP), [goToSection]);
  const openLedSetup = useCallback(() => void goToSection(SECTION_IDS.LED_SETUP), [goToSection]);
  return (
    <div className="h-full overflow-hidden">
      <DeviceSection.Component
        onNavigateToRoomMap={openRoomMap}
        onStopHueOutput={stopHueOutput}
        categoryRequest={categoryRequest}
        onVisibleCategoryChange={reportVisibleCategory}
        hueActive={hueActive}
        ambilightActive={ambilightActive}
        onOpenLedSetup={openLedSetup}
      />
    </div>
  );
});

const selectLocalOutputConnected = (state: LightingControlState) => state.localSink !== null;
const selectHueSessionActive = (status: HueShellStatus) => status.streaming || status.reconnecting;
const selectCheckingForUpdates = (snapshot: UpdaterSnapshot) => snapshot.state.status === "checking";
const selectUpToDateAt = (snapshot: UpdaterSnapshot) => snapshot.upToDateAt;

const SystemPanel = memo(function SystemPanel() {
  const localOutputConnected = useLightingControlState(selectLocalOutputConnected);
  const hueActive = useHueShellStatus(selectHueSessionActive);
  const isCheckingForUpdates = useUpdaterState(selectCheckingForUpdates);
  const upToDateAt = useUpdaterState(selectUpToDateAt);
  const { checkForUpdates, devSetState } = useUpdaterActions();
  const setupGuide = useSetupGuideActions();
  return (
    <div className="h-full overflow-hidden">
      <SystemSection
        onRestartSetupGuide={setupGuide?.restart}
        onCheckForUpdates={checkForUpdates}
        isCheckingForUpdates={isCheckingForUpdates}
        upToDateAt={upToDateAt}
        devSetUpdaterState={devSetState}
        localOutputConnected={localOutputConnected}
        hueActive={hueActive}
      />
    </div>
  );
});

const selectOutputTargets = (state: LightingControlState) => state.outputTargets;
const selectRoomMapHue = (status: HueShellStatus) => ({
  reachable: status.reachable,
  configured: status.configured,
  probeVerdict: status.probeVerdict,
});

const selectSavedLedTotal = (state: LightingControlState) => state.calibration?.totalLeds ?? null;

const RoomMapPanel = memo(function RoomMapPanel({
  onZoneCountsConfirmed,
}: {
  onZoneCountsConfirmed: (counts: LedSegmentCounts) => void;
}) {
  const outputTargets = useLightingControlState(selectOutputTargets);
  const savedLedTotal = useLightingControlState(selectSavedLedTotal);
  const hue = useHueShellStatus(selectRoomMapHue, shallowEqual);
  const { goToSection } = useNavigationActions();
  const openDevices = useCallback(() => void goToSection(SECTION_IDS.DEVICES), [goToSection]);
  // The counts open LED Setup as its draft; left in memory they would silently
  // become the baseline of whatever visit came next.
  const openCountsInLedSetup = useCallback(
    (counts: LedSegmentCounts) => {
      onZoneCountsConfirmed(counts);
      void goToSection(SECTION_IDS.LED_SETUP);
    },
    [onZoneCountsConfirmed, goToSection],
  );
  return (
    <div className="h-full overflow-hidden">
      <RoomMapEditor.Component
        onZoneCountsConfirmed={openCountsInLedSetup}
        savedLedTotal={savedLedTotal}
        onNavigateToDevices={openDevices}
        hueReachable={hue.reachable}
        outputTargets={outputTargets}
        hueConfigured={hue.configured}
        hueProbeVerdict={hue.probeVerdict}
      />
    </div>
  );
});

interface SectionPanelContext {
  pendingZoneCounts: LedSegmentCounts | null;
  setPendingZoneCounts: (counts: LedSegmentCounts | null) => void;
}

export interface SectionEntry {
  render: (context: SectionPanelContext) => ReactNode;
  /** Warms a split-out chunk; set for the full-only sections that are lazy. */
  preload?: () => void;
}

/** One row per section: a new `SectionId` fails to compile until it has a panel. */
export const SECTION_REGISTRY = {
  [SECTION_IDS.LIGHTS]: {
    render: () => <LightsPanel />,
  },
  [SECTION_IDS.LED_SETUP]: {
    render: ({ pendingZoneCounts, setPendingZoneCounts }) => (
      <CalibrationPanel
        key="calibration-page"
        pendingZoneCounts={pendingZoneCounts}
        onPendingZoneCountsChange={setPendingZoneCounts}
      />
    ),
    preload: CalibrationPage.preload,
  },
  [SECTION_IDS.DEVICES]: {
    render: () => <DevicesPanel />,
    preload: DeviceSection.preload,
  },
  [SECTION_IDS.SYSTEM]: {
    render: () => <SystemPanel />,
  },
  [SECTION_IDS.ROOM_MAP]: {
    render: ({ setPendingZoneCounts }) => (
      <RoomMapPanel onZoneCountsConfirmed={setPendingZoneCounts} />
    ),
    preload: RoomMapEditor.preload,
  },
} satisfies Record<SectionId, SectionEntry>;

function sectionEntry(id: SectionId): SectionEntry {
  return SECTION_REGISTRY[id];
}

export const SettingsLayout = memo(function SettingsLayout() {
  const { uiMode, activeSection } = useNavigationState(selectLayoutNavigation, shallowEqual);
  const [pendingZoneCounts, setPendingZoneCounts] = useState<LedSegmentCounts | null>(null);
  useFullOnlySectionPreload(uiMode);

  // ── Compact mode ──────────────────────────────────────────────────────
  if (uiMode === "compact") {
    return <CompactLayout />;
  }

  // ── Full mode ─────────────────────────────────────────────────────────
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden" data-testid="full-layout" style={{ background: "var(--lm-bg)", color: "var(--lm-ink)" }}>
      {/* Main content */}
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden" role="main" data-testid={`section-panel-${activeSection}`}>
        <Suspense fallback={<SectionPlaceholder />}>
          {sectionEntry(activeSection).render({
            pendingZoneCounts,
            setPendingZoneCounts,
          })}
        </Suspense>
      </main>
    </div>
  );
});
