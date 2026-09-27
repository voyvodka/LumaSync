import { memo, useEffect, useCallback, Suspense, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SECTION_IDS, SECTION_ORDER, type SectionId, type UIMode } from "@/shared/contracts/shell";
import { preloadableComponent } from "@/shared/lib/preloadableComponent";
import { shallowEqual } from "@/shared/lib/store";
import { LightsSection } from "./sections/LightsSection";
import { SettingsPage } from "./ui/SettingsPage";
import { buildDiagnostics } from "./ui/diagnostics";
import { detectOsName } from "./ui/helpLinks";
import { getPreference } from "../persistence/preferences";
import { APP_NAME, APP_VERSION } from "@/shared/constants/app";
import {
  useLightingActions,
  useLightingControlReader,
  useLightingControlState,
  type LightingControlState,
} from "../mode/state/lightingControl";
import {
  useNavigationActions,
  useNavigationState,
  useVisibleDeviceCategoryReporter,
  type NavigationState,
} from "../shell/navigationStore";
import { useUpdaterActions, useUpdaterState, type UpdaterSnapshot } from "../updater/UpdaterProvider";
import { useHueShellStatus, useHueShellStatusReader, type HueShellStatus } from "../hue/state/hueShellStatus";
import { useSetupGuideActions } from "../onboarding/state/setupGuideControl";
import { CompactLayout } from "./sections/compact/CompactLayout";
import { CalibrationPanel, preloadCalibrationPanel } from "../calibration/ui/CalibrationPanel";
import type { RoomMapEditorProps } from "@/features/room-map/ui/RoomMapEditor";

// The full-only sections that each outweigh the rest of the shell are split out,
// so the compact window never parses them (LED Setup's is in its own panel). See
// docs/architecture/ui-and-shell.md, "Per-window bundles".
const DevicesPage = preloadableComponent("DevicesPage", () =>
  import("@/features/device/ui/DevicesPage").then((m) => m.DevicesPage),
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

const selectDeviceCategoryRequest = (state: NavigationState) => state.deviceCategoryRequest;
const selectHueActive = (status: HueShellStatus) => status.configured && status.streaming;

const DevicesPanel = memo(function DevicesPanel() {
  const categoryRequest = useNavigationState(selectDeviceCategoryRequest);
  const hueActive = useHueShellStatus(selectHueActive);
  const reportVisibleCategory = useVisibleDeviceCategoryReporter();
  const { goToSection } = useNavigationActions();
  const { stopHueOutput } = useLightingActions();
  const openRoomMap = useCallback(() => void goToSection(SECTION_IDS.ROOM_MAP), [goToSection]);
  return (
    <div className="h-full overflow-hidden">
      <DevicesPage.Component
        onNavigateToRoomMap={openRoomMap}
        onStopHueOutput={stopHueOutput}
        categoryRequest={categoryRequest}
        onVisibleCategoryChange={reportVisibleCategory}
        hueActive={hueActive}
      />
    </div>
  );
});

const selectLocalOutputConnected = (state: LightingControlState) => state.localSink !== null;
const selectHueSessionActive = (status: HueShellStatus) => status.streaming || status.reconnecting;
const selectCheckingForUpdates = (snapshot: UpdaterSnapshot) => snapshot.state.status === "checking";
const selectUpToDateAt = (snapshot: UpdaterSnapshot) => snapshot.upToDateAt;

const SystemPanel = memo(function SystemPanel() {
  const { i18n } = useTranslation();
  const localOutputConnected = useLightingControlState(selectLocalOutputConnected);
  const hueActive = useHueShellStatus(selectHueSessionActive);
  // Read at the press, not subscribed to: the panel must not re-render for state it never draws.
  const readLighting = useLightingControlReader();
  const readHue = useHueShellStatusReader();
  const readDiagnostics = useCallback(() => {
    const lighting = readLighting();
    return buildDiagnostics({
      appName: APP_NAME,
      appVersion: APP_VERSION,
      os: detectOsName(),
      channel: getPreference("updateChannel"),
      mode: lighting.lightingMode.kind,
      outputs: lighting.outputTargets,
      localSink: lighting.localSink,
      calibration: lighting.calibration,
      hue: readHue(),
      uiZoom: getPreference("uiZoom"),
      motion: getPreference("motion"),
      language: i18n?.language ?? "en",
    });
  }, [readLighting, readHue, i18n]);
  const isCheckingForUpdates = useUpdaterState(selectCheckingForUpdates);
  const upToDateAt = useUpdaterState(selectUpToDateAt);
  const { checkForUpdates, devSetState } = useUpdaterActions();
  const setupGuide = useSetupGuideActions();
  return (
    <div className="h-full overflow-hidden">
      <SettingsPage
        onRestartSetupGuide={setupGuide?.restart}
        onCheckForUpdates={checkForUpdates}
        isCheckingForUpdates={isCheckingForUpdates}
        upToDateAt={upToDateAt}
        devSetUpdaterState={devSetState}
        localOutputConnected={localOutputConnected}
        hueActive={hueActive}
        readDiagnostics={readDiagnostics}
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

const RoomMapPanel = memo(function RoomMapPanel() {
  const outputTargets = useLightingControlState(selectOutputTargets);
  const hue = useHueShellStatus(selectRoomMapHue, shallowEqual);
  const { goToSection } = useNavigationActions();
  const openDevices = useCallback(() => void goToSection(SECTION_IDS.DEVICES), [goToSection]);
  return (
    <div className="h-full overflow-hidden">
      <RoomMapEditor.Component
        onNavigateToDevices={openDevices}
        hueReachable={hue.reachable}
        outputTargets={outputTargets}
        hueConfigured={hue.configured}
        hueProbeVerdict={hue.probeVerdict}
      />
    </div>
  );
});

export interface SectionEntry {
  render: () => ReactNode;
  /** Warms a split-out chunk; set for the full-only sections that are lazy. */
  preload?: () => void;
}

/** One row per section: a new `SectionId` fails to compile until it has a panel. */
export const SECTION_REGISTRY = {
  [SECTION_IDS.LIGHTS]: {
    render: () => <LightsPanel />,
  },
  [SECTION_IDS.LED_SETUP]: {
    render: () => <CalibrationPanel key="calibration-page" />,
    preload: preloadCalibrationPanel,
  },
  [SECTION_IDS.DEVICES]: {
    render: () => <DevicesPanel />,
    preload: DevicesPage.preload,
  },
  [SECTION_IDS.SYSTEM]: {
    render: () => <SystemPanel />,
  },
  [SECTION_IDS.ROOM_MAP]: {
    render: () => <RoomMapPanel />,
    preload: RoomMapEditor.preload,
  },
} satisfies Record<SectionId, SectionEntry>;

function sectionEntry(id: SectionId): SectionEntry {
  return SECTION_REGISTRY[id];
}

export const SettingsLayout = memo(function SettingsLayout() {
  const { uiMode, activeSection } = useNavigationState(selectLayoutNavigation, shallowEqual);
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
          {sectionEntry(activeSection).render()}
        </Suspense>
      </main>
    </div>
  );
});
