/**
 * App.tsx — the shell. Composes the feature hooks in dependency order, owns
 * routing plus the slices with no single feature home (calibration, Hue
 * pairing config, onboarding flags), and renders the tree. Sections read what
 * they show from the lighting, navigation, updater and Hue status stores, not
 * from props; see docs/architecture/ui-and-shell.md, "Shell state reaches
 * sections through stores".
 */

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { SettingsLayout } from "./features/settings/SettingsLayout";
import { TitleBar, TITLE_BAR_HEIGHT_PX } from "./features/shell/TitleBar";
import { StatusBar, statusBarHeightPx } from "./features/shell/StatusBar";
import { useTrayIntegration, type TrayOutput } from "./features/shell/useTrayIntegration";
import { useShellBootstrap } from "./features/shell/useShellBootstrap";
import { openScreenCaptureSettings } from "./features/mode/captureApi";
import { useCaptureStallNotice } from "./features/telemetry/hooks/useCaptureStallNotice";
import { useHueSolidColorNotice } from "./features/mode/state/useHueSolidColorNotice";
import { useHueTargetAutoAdd } from "./features/mode/state/useHueTargetAutoAdd";
import { usePreviewOpenNotice } from "./features/preview/state/usePreviewOpenNotice";
import { useLightingModeOrchestrator } from "./features/mode/state/useLightingModeOrchestrator";
import { useHueBridgeReachability } from "./features/hue/state/useHueBridgeReachability";
import { HueShellStatusProvider, type HueShellStatus } from "./features/hue/state/hueShellStatus";
import {
  isHueSessionReconnecting,
  isHueStreamDead,
  isHueStreamFailed,
  useHueStreamHealth,
} from "./features/hue/state/useHueStreamHealth";
import { buildStatusItems, resolveHueHeldOut } from "./features/shell/statusItems";
import { buildShellNotices, type ShellNoticeHandlers } from "./features/shell/notices/buildShellNotices";
import { currentNoticeView } from "./features/shell/notices/noticeModel";
import { useShellNoticeQueue } from "./features/shell/notices/useShellNoticeQueue";
import { ShellNoticeAnnouncer, ShellNoticeSlot } from "./features/shell/notices/ShellNoticeSlot";
import { useOnboardingStep } from "./features/onboarding/state/useOnboardingStep";
import {
  INITIAL_ONBOARDING_STEP,
  NO_ONBOARDING_BOOT_FACTS,
  ONBOARDING_STEPS,
  settleStep,
  type OnboardingBootFacts,
  type OnboardingGuardSnapshot,
} from "./features/onboarding/state/onboardingState";
import { SetupGuideProvider, type SetupGuideRestartResult } from "./features/onboarding/state/setupGuideControl";
import { useBackgroundUpdateChecks } from "./features/updater/useBackgroundUpdateChecks";
import {
  UpdateModalHost,
  UpdaterProvider,
  useUpdaterActions,
  useUpdaterState,
  type UpdaterSnapshot,
} from "./features/updater/UpdaterProvider";
import { isUpdateModalStatus } from "./features/updater/updateModalStatus";
import { outputAvailability } from "./features/mode/model/outputAvailability";
import { useCapturePermissionRecheck } from "./features/mode/state/useCapturePermissionRecheck";
import type { DeviceCategory } from "./features/settings/sections/DeviceSection";
import { CAPTURE_FAILURE_BUCKET } from "./shared/contracts/capture";
import { HUE_RUNTIME_TRIGGER_SOURCE } from "./shared/contracts/hue";
import { startCalibrationFromSettings } from "./features/calibration/state/entryFlow";
import { useLedSetupPrompt } from "./features/calibration/state/useLedSetupPrompt";
import { useDeviceConnection } from "./features/device/useDeviceConnection";
import { useActiveWledSink, useWledSinkRestore } from "./features/device/useWledSink";
import { deriveLocalSink } from "./features/device/localSink";
import { useUsbTargetReconciler } from "./features/device/state/useUsbTargetReconciler";
import {
  canEnableLedMode,
  MODE_GUARD_REASONS,
} from "./features/mode/state/modeGuard";
import { LightingControlProvider } from "./features/mode/state/lightingControl";
import {
  LIGHTING_MODE_KIND,
  type LightingModeConfig,
  type LightingModeKind,
} from "@/shared/contracts/mode";
import type { HueStartConfig } from "./features/hue/model/hueStartConfig";
import { useStableHueStartConfig } from "./features/hue/state/useStableHueStartConfig";
import { useHueStartConfigSync } from "./features/hue/state/useHueStartConfigSync";
import type { LedCalibrationConfig } from "./features/calibration/model/contracts";
import { saveShellState } from "./features/shell/windowLifecycle";
import {
  useUIMode,
  UI_MODE_FADE_DURATION_MS,
  UI_MODE_FADE_TIMING,
} from "./features/shell/useUIMode";
import { useGlobalKeybinds, type KeybindHandlers } from "./features/shell/useGlobalKeybinds";
import { modeKeybindHandlers } from "./features/shell/modeKeybinds";
import { modeKind } from "./features/mode/model/modeKinds";
import { useWindowVisible } from "./features/shell/windowVisibility";
import { useShellStateWriteFailing } from "./features/persistence/writeHealth";
import {
  createNavigationStore,
  NavigationProvider,
  type NavigationState,
} from "./features/shell/navigationStore";
import { useStoreSelector } from "./shared/lib/store";
import {
  KEYBIND_ACTIONS,
  SECTION_IDS,
  type SectionId,
  type UIMode,
} from "./shared/contracts/shell";

const selectActiveSection = (state: NavigationState) => state.activeSection;
const selectNoticeView = (state: NavigationState) => currentNoticeView(state);
const selectUpdaterStatus = (snapshot: UpdaterSnapshot) => snapshot.state.status;
const selectUpdateCheckFailedNotice = (snapshot: UpdaterSnapshot) => snapshot.checkFailedNotice;
const selectUpdateModalShown = (snapshot: UpdaterSnapshot) =>
  snapshot.isModalOpen && isUpdateModalStatus(snapshot.state);

function Shell() {
  const { t } = useTranslation();
  // Slices only: a download's progress re-renders the modal, not the shell.
  const updaterStatus = useUpdaterState(selectUpdaterStatus);
  const updateCheckFailedNotice = useUpdaterState(selectUpdateCheckFailedNotice);
  const updateModalShown = useUpdaterState(selectUpdateModalShown);
  const { checkForUpdates, checkForUpdatesInBackground } = useUpdaterActions();
  const {
    currentMode,
    isContentVisible,
    contentRef,
    switchUIMode,
    setCurrentMode,
  } = useUIMode();
  const [navigation] = useState(createNavigationStore);
  const activeSection = useStoreSelector(navigation, selectActiveSection);
  const noticeView = useStoreSelector(navigation, selectNoticeView);
  const { setActiveSection } = navigation;
  useLayoutEffect(() => {
    navigation.setUIMode(currentMode);
  }, [navigation, currentMode]);
  const [savedCalibration, setSavedCalibration] = useState<LedCalibrationConfig | undefined>(undefined);
  const [hueStartConfig, setHueStartConfig] = useStableHueStartConfig();
  // Mirror of `hueStartConfig` so the connection-event subscriber (in a
  // useEffect with `[]` deps) can read the latest paired-bridge state
  // without re-subscribing on every state mutation.
  const hueStartConfigRef = useRef<HueStartConfig | null>(null);
  const { isConnected, connectedPort, ports, lastSuccessfulPort } = useDeviceConnection();
  // Boot restore of the persisted WLED sink. Mounted here, not in the picker:
  // the sink must be bound before a lighting mode starts.
  useWledSinkRestore();
  // The Lights screen needs to know whether *any* local output is bound, not
  // whether a serial port is. Without this a WLED-only setup reads as "no
  // strip connected" and every non-Off mode stays disabled, while Rust is
  // perfectly able to drive the panel.
  const { activeWledIp, savedSink: savedWledSink } = useActiveWledSink();
  const connectedProduct = ports.find((port) => port.portName === connectedPort)?.product;
  // Memoised because the lighting store compares by identity: a fresh object
  // per render would re-render every section that reads it.
  const localSink = useMemo(
    () => deriveLocalSink(isConnected, connectedPort ?? null, activeWledIp, connectedProduct),
    [isConnected, connectedPort, activeWledIp, connectedProduct],
  );
  // Latched: a strip unplugged this session is an outage, not "never set up".
  const [localSinkSeen, setLocalSinkSeen] = useState(false);
  if (localSink !== null && !localSinkSeen) setLocalSinkSeen(true);
  // Defaults to `true` so a hydrating store never flashes the banner at a user
  // who has already dismissed it; bootstrap flips it false for a fresh install.
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState<boolean>(true);
  const [onboardingBoot, setOnboardingBootFacts] = useState<OnboardingBootFacts>(NO_ONBOARDING_BOOT_FACTS);
  const [onboardingRestartKey, setOnboardingRestartKey] = useState(0);

  const { notice: hueColorNotice, report: reportHueSolidColorStatus } =
    useHueSolidColorNotice();
  const { notice: previewOpenNotice, report: reportPreviewOpenFailure } = usePreviewOpenNotice();

  const handleOpenCalibration = useCallback(() => {
    const entry = startCalibrationFromSettings(savedCalibration);
    // Through the leave guard like every other move: a mode press that needs a
    // layout must not unmount another screen's unsaved work either.
    if (entry.open && navigation.get().activeSection !== SECTION_IDS.LED_SETUP) {
      navigation.requestLeave(() => setActiveSection(SECTION_IDS.LED_SETUP));
    }
  }, [navigation, savedCalibration, setActiveSection]);

  const mode = useLightingModeOrchestrator({
    onRequireCalibration: handleOpenCalibration,
    reportHueSolidColorStatus,
  });
  const {
    lightingMode,
    selectedOutputTargets,
    activeOutputTargets,
    isModeTransitioning,
    handleLightingModeChange,
    handleOutputTargetsChange,
  } = mode;

  // Deliberately outside `bootstrap()` — behind shellStore, Hue, USB and DTLS the
  // release probe landed well past the user's first frame. A failure here is a
  // notice, never the modal: nobody asked for this check. It repeats daily, and
  // a failed one retries sooner; see `updateCheckSchedule.ts`.
  useBackgroundUpdateChecks(checkForUpdatesInBackground);

  const { runtimeState: hueRuntimeState } = useHueStreamHealth({
    hueTargetSelected: selectedOutputTargets.includes("hue"),
  });

  // Membership means the app owns a Hue session, not that frames reach the
  // bridge: RECONNECTING keeps the target. Only the shown state is split; the
  // probe and the reachability fallbacks still key on the session. A stream the
  // backend reports dead is no session, whatever the snapshot still drives.
  const hueSessionActive = activeOutputTargets.includes("hue") && !isHueStreamDead(hueRuntimeState);
  const hueReconnecting = isHueSessionReconnecting(hueSessionActive, hueRuntimeState);
  const hueStreaming = hueSessionActive && !hueReconnecting;
  const hueStreamFailed = isHueStreamFailed(hueRuntimeState);
  const hueProbe = useHueBridgeReachability(hueStartConfig, hueSessionActive);
  const hueReachable = hueProbe.reachable;
  // What the sections show about Hue, through the Hue status store.
  const hueShellStatus: HueShellStatus = {
    configured: hueStartConfig !== null,
    reachable: hueReachable || hueSessionActive,
    probeVerdict: hueProbe.verdict,
    streaming: hueStreaming,
    reconnecting: hueReconnecting,
    streamFailed: hueStreamFailed,
  };

  // The USB reconciler needs `bootstrapDone`, so it cannot be declared above
  // the boot sequence; arming reaches it through a ref rather than moving the
  // boot effect below every other effect.
  const armUsbConnectedRef = useRef<((connected: boolean) => void) | null>(null);
  const { bootstrapDone, lightingRestored } = useShellBootstrap({
    t,
    setUIMode: setCurrentMode,
    setActiveSection,
    setSavedCalibration,
    setHasCompletedOnboarding,
    setOnboardingBootFacts,
    setHueStartConfig,
    armUsbConnected: (connected) => armUsbConnectedRef.current?.(connected),
    restoreLighting: mode.restoreAtBoot,
  });

  const {
    usbDisconnectNotice,
    usbDisconnectLightingOffNotice,
    usbUnsupportedNotice,
    usbUnsupportedHueFallback,
    armUsbConnected,
  } =
    useUsbTargetReconciler({
      isConnected,
      // It writes a selection from the one it reads, which the restore sets.
      bootstrapDone: bootstrapDone && lightingRestored,
      selectedOutputTargets,
      lightingRunning: lightingMode.kind !== LIGHTING_MODE_KIND.OFF,
      selectedOutputTargetsRef: mode.selectedOutputTargetsRef,
      hueStartConfigRef,
      onSelectTargets: handleOutputTargetsChange,
      onDropUsbTarget: mode.dropUnpluggedUsbTarget,
      onLastTargetUnplugged: mode.endLightingOnUsbUnplug,
    });
  armUsbConnectedRef.current = armUsbConnected;
  useHueTargetAutoAdd({
    ready: bootstrapDone && lightingRestored,
    hueConfigured: hueStartConfig !== null,
    selectedOutputTargets,
    onSelectTargets: handleOutputTargetsChange,
  });

  useHueStartConfigSync(setHueStartConfig);
  useEffect(() => { hueStartConfigRef.current = hueStartConfig; }, [hueStartConfig]);
  const trayOutputs: TrayOutput[] = [];
  if (activeOutputTargets.includes("usb") && localSink !== null) {
    trayOutputs.push(localSink.transport === "wled" ? "wled" : "usb");
  }
  if (hueSessionActive) trayOutputs.push("hue");
  useTrayIntegration({
    onPreviewOpenFailed: reportPreviewOpenFailure,
    status: { mode: lightingMode.kind, outputs: trayOutputs },
  });

  const runSectionChange = useCallback(async (sectionId: SectionId, deviceCategory?: DeviceCategory) => {
    // Only a notice names a category; every other way in keeps the one open.
    // Set before the switch so the full layout mounts on the target section;
    // CompactLayout ignores it meanwhile.
    navigation.openSection(sectionId, deviceCategory);
    // CompactLayout ignores `activeSection`, so a deep-link from the banner, a
    // CTA or the tray would set it silently and leave the user staring at the
    // LIGHTS panel. Switch to full first, or the click appears to do nothing.
    if (sectionId !== SECTION_IDS.LIGHTS) {
      await switchUIMode("full");
    }
    try {
      await saveShellState({ lastSection: sectionId });
    } catch (err) {
      console.error("[LumaSync] saveShellState(lastSection) failed:", err);
    }
  }, [navigation, switchUIMode]);

  // Every way off the open screen asks its leave guard first — LED Setup holds
  // an unsaved draft that would otherwise unmount without a word. A held move
  // resolves at once; it runs later, or never, on the user's answer.
  const handleSectionChange = useCallback((sectionId: SectionId, deviceCategory?: DeviceCategory) => {
    if (sectionId === navigation.get().activeSection) return runSectionChange(sectionId, deviceCategory);
    let pending: Promise<void> = Promise.resolve();
    navigation.requestLeave(() => {
      pending = runSectionChange(sectionId, deviceCategory);
    });
    return pending;
  }, [navigation, runSectionChange]);

  // Compact never shows the full-only screens, so going there is a leave too.
  const guardedSwitchUIMode = useCallback((nextMode: UIMode): Promise<void> => {
    if (nextMode !== "compact") return switchUIMode(nextMode);
    let pending: Promise<void> = Promise.resolve();
    navigation.requestLeave(() => {
      pending = switchUIMode(nextMode);
    });
    return pending;
  }, [navigation, switchUIMode]);

  // A connect the user made with no saved layout points at LED Setup; the user stays put.
  const ledSetupNextPort = useLedSetupPrompt({
    ready: bootstrapDone,
    connected: isConnected,
    hasCalibration: savedCalibration !== undefined,
    onLedSetup: activeSection === SECTION_IDS.LED_SETUP,
  });

  const modeGuard = canEnableLedMode(savedCalibration, selectedOutputTargets, localSink !== null);

  const captureStalledNotice = useCaptureStallNotice(
    lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT,
  );

  // What the mode controls read, published to the sections through the
  // lighting store. Each section selects its own slice of it.
  const lightingControlState = {
    lightingMode,
    outputTargets: selectedOutputTargets,
    isModeTransitioning,
    modeLockReason:
      modeGuard.reason === MODE_GUARD_REASONS.CALIBRATION_REQUIRED
        ? modeGuard.reason
        : null,
    calibration: savedCalibration,
    localSink,
    bootstrapDone,
  };
  // Fresh closures are fine: the provider hands the sections stable wrappers.
  const lightingControlActions = {
    changeMode: (next: LightingModeConfig) => {
      void handleLightingModeChange(next);
    },
    changeOutputTargets: handleOutputTargetsChange,
    stopHueOutput: mode.stopHueOutput,
    saveCalibration: (config: LedCalibrationConfig) => {
      setSavedCalibration(config);
    },
  };
  const navigationActions = {
    goToSection: handleSectionChange,
    switchUIMode: guardedSwitchUIMode,
  };

  // Persists the flag and unmounts the guide on the next render. Called when
  // the last step's guard holds, and by the notice's "Skip setup guide".
  const handleOnboardingComplete = useCallback(() => {
    setHasCompletedOnboarding(true);
    void saveShellState({ hasCompletedOnboarding: true }).catch((err) => {
      console.error("[LumaSync] saveShellState(hasCompletedOnboarding) failed:", err);
    });
  }, []);

  const lightingRunning = lightingMode.kind !== LIGHTING_MODE_KIND.OFF && activeOutputTargets.length > 0;
  const onboardingGuards: OnboardingGuardSnapshot = {
    hasReachableOutput: localSink !== null || hueReachable || hueSessionActive,
    hasLocalOutput: localSinkSeen,
    hasSavedCalibration: savedCalibration !== undefined,
    hasLightingRun: onboardingBoot.hasRunLighting || lightingRunning,
  };
  const onboarding = useOnboardingStep({
    hasCompleted: hasCompletedOnboarding,
    guards: onboardingGuards,
    // The launch restore runs the saved mode, which is the last step's guard.
    guardsLoaded: bootstrapDone && lightingRestored,
    reachabilityPending: hueStartConfig !== null && hueProbe.verdict === null && !hueSessionActive,
    outputRemembered: onboardingBoot.outputRemembered,
    restartKey: onboardingRestartKey,
    onComplete: handleOnboardingComplete,
  });

  // Nothing to bring back when every guard already holds: the guide would
  // complete again on its first render, and the button would seem dead.
  const restartSetupGuide = (): SetupGuideRestartResult => {
    if (settleStep(INITIAL_ONBOARDING_STEP, onboardingGuards) === ONBOARDING_STEPS.COMPLETE) return "alreadyDone";
    setHasCompletedOnboarding(false);
    setOnboardingRestartKey((key) => key + 1);
    void saveShellState({ hasCompletedOnboarding: false }).catch((err) => {
      console.error("[LumaSync] saveShellState(hasCompletedOnboarding=false) failed:", err);
    });
    return "shown";
  };

  const openDevicesSection = (category: DeviceCategory) =>
    void handleSectionChange(SECTION_IDS.DEVICES, category);

  // The same inputs the layouts gate the mode buttons on, so the notice that
  // explains a dim button can never disagree with it.
  const availability = outputAvailability({
    localOutputConnected: localSink !== null,
    hueConfigured: hueStartConfig !== null,
    hueReachable: hueReachable || hueSessionActive,
    hueProbeVerdict: hueProbe.verdict,
    bootstrapDone,
  });

  // Global keyboard shortcuts — the behaviour behind every `<kbd>` badge in
  // `KEYBIND_REGISTRY`. The hook is disabled during a UI-mode fade: firing
  // ⌥1/⌥2/⌥3 mid-transition is what produced the "ghost mode flash". A mode
  // shortcut is off wherever its button is; the gate matches the mode strips.
  const isModeKindDisabled = (kind: LightingModeKind) =>
    kind === LIGHTING_MODE_KIND.OFF
      ? isModeTransitioning
      : isModeTransitioning ||
        availability !== "ready" ||
        modeGuard.reason === MODE_GUARD_REASONS.CALIBRATION_REQUIRED;
  const ambilightDisabled = isModeKindDisabled(LIGHTING_MODE_KIND.AMBILIGHT);
  // Read at press time through the hook's ref, so fresh closures cost nothing.
  const keybindHandlers: KeybindHandlers = {
    // ⌘, / Ctrl+, is the canonical open-settings shortcut on all three
    // platforms; the section change switches compact to full itself.
    [KEYBIND_ACTIONS.OPEN_SETTINGS]: () => void handleSectionChange(SECTION_IDS.SYSTEM),
    ...modeKeybindHandlers(lightingControlActions.changeMode, isModeKindDisabled),
  };
  useGlobalKeybinds(keybindHandlers, { disabled: !isContentVisible });

  useCapturePermissionRecheck(
    mode.startFailedNotice?.bucket === CAPTURE_FAILURE_BUCKET.PERMISSION,
    mode.clearCapturePermissionNotice,
  );

  // Read at click time, so the memoised notices below need not change identity
  // every render just because a handler closure did.
  const noticeHandlersRef = useRef<ShellNoticeHandlers | null>(null);
  noticeHandlersRef.current = {
    openCaptureSettings: () => void openScreenCaptureSettings(),
    openDevices: (category) => void handleSectionChange(SECTION_IDS.DEVICES, category),
    openLedSetup: () => void handleSectionChange(SECTION_IDS.LED_SETUP),
    openLights: () => void handleSectionChange(SECTION_IDS.LIGHTS),
    retryHueProbe: hueProbe.retry,
    retryHueStop: () => void mode.stopHueOutput(HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL),
    completeOnboarding: handleOnboardingComplete,
    // The kind alone, as ⌥2 does: Rust keeps the last Ambilight settings.
    turnOnAmbilight: () => lightingControlActions.changeMode(modeKind(LIGHTING_MODE_KIND.AMBILIGHT).config({})),
    retryUpdateCheck: () => void checkForUpdates(),
  };
  const noticeHandlers = useMemo<ShellNoticeHandlers>(
    () => ({
      openCaptureSettings: () => noticeHandlersRef.current?.openCaptureSettings(),
      openDevices: (category) => noticeHandlersRef.current?.openDevices(category),
      openLedSetup: () => noticeHandlersRef.current?.openLedSetup(),
      openLights: () => noticeHandlersRef.current?.openLights(),
      retryHueProbe: () => noticeHandlersRef.current?.retryHueProbe?.(),
      retryHueStop: () => noticeHandlersRef.current?.retryHueStop(),
      completeOnboarding: () => noticeHandlersRef.current?.completeOnboarding(),
      turnOnAmbilight: () => noticeHandlersRef.current?.turnOnAmbilight(),
      retryUpdateCheck: () => noticeHandlersRef.current?.retryUpdateCheck(),
    }),
    [],
  );
  // Bound, not merely selected: every fresh install starts with `usb` selected.
  const localTargetConfigured = localSink !== null;
  const localTransport = localSink?.transport ?? null;
  const settingsWriteFailing = useShellStateWriteFailing();
  const noticeCandidates = useMemo(
    () =>
      buildShellNotices(
        {
          uiMode: currentMode,
          activeSection,
          availability,
          hueProbeGaveUp: hueProbe.gaveUp,
          hueProbeChecking: hueProbe.probing,
          // Before boot the saved calibration is simply unread, not missing.
          calibrationRequired: bootstrapDone && modeGuard.reason === MODE_GUARD_REASONS.CALIBRATION_REQUIRED,
          startFailure: mode.startFailedNotice,
          captureStalled: captureStalledNotice,
          stopFailedTargets: mode.stopFailedNotice,
          previewOpenFailure: previewOpenNotice,
          hueLeftOut: mode.hueLeftOutNotice,
          hueNotStarted: mode.hueNotStartedNotice,
          usbLeftOut: mode.usbLeftOutNotice,
          hueBootRetry: mode.bootHueRetryNotice,
          usbDisconnected: usbDisconnectNotice,
          usbDisconnectedLightingOff: usbDisconnectLightingOffNotice,
          usbUnsupported: usbUnsupportedNotice,
          usbUnsupportedHueFallback,
          hueColorNotice,
          onboardingStep: onboarding.step,
          onboardingPending: onboarding.pending,
          ambilightReady: !ambilightDisabled,
          modeTransitioning: isModeTransitioning,
          ledSetupNext: ledSetupNextPort,
          localTargetConfigured,
          localTransport,
          settingsWriteFailing,
          updateCheckFailed: updateCheckFailedNotice,
          updateChecking: updaterStatus === "checking",
        },
        noticeHandlers,
        t,
      ),
    [
      currentMode,
      activeSection,
      availability,
      hueProbe.gaveUp,
      hueProbe.probing,
      bootstrapDone,
      modeGuard.reason,
      mode.startFailedNotice,
      captureStalledNotice,
      mode.stopFailedNotice,
      previewOpenNotice,
      mode.hueLeftOutNotice,
      mode.hueNotStartedNotice,
      mode.usbLeftOutNotice,
      mode.bootHueRetryNotice,
      usbDisconnectNotice,
      usbDisconnectLightingOffNotice,
      usbUnsupportedNotice,
      usbUnsupportedHueFallback,
      hueColorNotice,
      onboarding.step,
      onboarding.pending,
      ambilightDisabled,
      isModeTransitioning,
      ledSetupNextPort,
      localTargetConfigured,
      localTransport,
      settingsWriteFailing,
      updateCheckFailedNotice,
      updaterStatus,
      noticeHandlers,
      t,
    ],
  );
  // In the tray nobody can read a notice, so none may time out there: an event
  // raised or expiring while hidden is kept until the window is back.
  const windowVisible = useWindowVisible();
  const noticeQueue = useShellNoticeQueue(noticeCandidates, {
    suppressed: updateModalShown || !windowVisible,
    view: noticeView,
  });

  const statusItems = buildStatusItems(
    {
      ambilightActive: lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT,
      localSink,
      // Before boot the remembered port and WLED sink are simply unread.
      localEverConfigured:
        !bootstrapDone || localSinkSeen || Boolean(lastSuccessfulPort) || (savedWledSink ?? null) !== null,
      hueStreaming,
      hueReconnecting,
      hueFailed: hueStreamFailed,
      hueHeldOut: resolveHueHeldOut({
        leftOutReason: mode.hueHeldOutReason,
        bootHueRetry: mode.bootHueRetryNotice,
        lightingRunning: lightingMode.kind !== LIGHTING_MODE_KIND.OFF,
        hueSessionActive,
      }),
      hueReachable,
      hueConfigured: hueStartConfig !== null,
      onOpenDevices: openDevicesSection,
    },
    t,
  );
  const statusBarHeight = statusBarHeightPx(currentMode);

  return (
    <NavigationProvider store={navigation} actions={navigationActions}>
      <LightingControlProvider state={lightingControlState} actions={lightingControlActions}>
        <HueShellStatusProvider status={hueShellStatus}>
        <SetupGuideProvider actions={{ restart: restartSetupGuide }}>
        {/* Custom cross-platform title bar. Sits above everything. Handles
            native drag + double-click zoom, hosts the compact-mode toggle, and
            (on Windows/Linux) draws custom min/max/close buttons since native
            decorations are disabled there. See TitleBar.tsx for details. */}
        <TitleBar
          uiMode={currentMode}
          onSwitchUIMode={guardedSwitchUIMode}
          activeSection={activeSection}
          onSectionChange={(id) => void handleSectionChange(id)}
        />

        {/* Persistent dark backdrop so the space between the fade-out and
            fade-in phases blends with the layout background instead of
            revealing the desktop. Offset by the title bar at the top and the
            status bar at the bottom so neither overlaps the content slot. */}
        <div
          className="fixed right-0 left-0 overflow-hidden"
          style={{
            top: `${TITLE_BAR_HEIGHT_PX}px`,
            bottom: `${statusBarHeight}px`,
            background: "var(--lm-bg)",
          }}
        >
          {/*
           * Single content slot — sequential fade-out → window resize →
           * fade-in, orchestrated by `useUIMode`. Running the resize while
           * the content is at opacity 0 removes the progressive-clipping
           * artifact that a parallel cross-fade produced when slot pinning
           * forced the incoming layout to overflow the still-animating
           * window. Easing matches `easeOutCubic` in `animateWindowRect`
           * so the three phases read as one continuous motion.
           */}
          {/* A flex column, not a block: the layout sizes itself to 100% of this
              box, so an in-flow banner above it pushed exactly its own height off
              the bottom, past the layout's own scroll container. See
              docs/architecture/ui-and-shell.md. */}
          <div
            ref={contentRef}
            className={`absolute inset-0 flex flex-col ${
              isContentVisible ? "" : "pointer-events-none"
            }`}
            style={{
              opacity: isContentVisible ? 1 : 0,
              // The recede-and-settle is deliberate: with a matched backdrop it
              // reads as a breathe rather than as content vanishing.
              transform: isContentVisible ? "scale(1)" : "scale(0.985)",
              filter: isContentVisible ? "blur(0px)" : "blur(6px)",
              transformOrigin: "center center",
              willChange: "opacity, transform, filter",
              transitionProperty: "opacity, transform, filter",
              transitionDuration: `${UI_MODE_FADE_DURATION_MS}ms`,
              transitionTimingFunction: UI_MODE_FADE_TIMING,
            }}
          >
            <ShellNoticeSlot
              variant={currentMode}
              queue={noticeQueue}
              suppressed={updateModalShown}
              holdSpace={onboarding.pending || !bootstrapDone}
            />
            <div className="min-h-0 flex-1">
              {/* No props: everything reaches the sections through the stores,
                  so a render of this shell stops at the memo. */}
              <SettingsLayout />
            </div>
          </div>
        </div>
        <StatusBar
          items={statusItems}
          uiMode={currentMode}
          lightingActive={lightingMode.kind !== LIGHTING_MODE_KIND.OFF}
        />
        <ShellNoticeAnnouncer queue={noticeQueue} />
        {/* After the notices, and above them: the modal owns the screen, and the
            queue waits under it, inert and outside its focus trap. */}
        <UpdateModalHost />
        </SetupGuideProvider>
        </HueShellStatusProvider>
      </LightingControlProvider>
    </NavigationProvider>
  );
}

/**
 * The updater sits above the shell, so a download's progress events re-render
 * the provider and the modal and stop there.
 */
function App() {
  return (
    <UpdaterProvider>
      <Shell />
    </UpdaterProvider>
  );
}

export default App;
