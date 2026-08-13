/**
 * App.tsx — the shell. Composes the feature hooks in dependency order, owns
 * routing plus the four slices with no single feature home (section,
 * calibration, Hue pairing config, onboarding flags), and renders the tree.
 */

// DEV PREVIEW — uncomment + comment out "export default App" below to preview
// import { HueAreaPreview } from "./dev/HueAreaPreview";
// export { HueAreaPreview as default };

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { SettingsLayout } from "./features/settings/SettingsLayout";
import { TitleBar, TITLE_BAR_HEIGHT_PX } from "./features/shell/TitleBar";
import { StatusBar, statusBarHeightPx } from "./features/shell/StatusBar";
import { useTrayIntegration } from "./features/shell/useTrayIntegration";
import { useShellBootstrap } from "./features/shell/useShellBootstrap";
import { useModeRuntimeConfig } from "./features/mode/state/useModeRuntimeConfig";
import { useHueSolidColorNotice } from "./features/mode/state/useHueSolidColorNotice";
import { useModeHotReload } from "./features/mode/state/useModeHotReload";
import { useLightingModeOrchestrator } from "./features/mode/state/useLightingModeOrchestrator";
import { useHueBridgeReachability } from "./features/hue/state/useHueBridgeReachability";
import { useHueStreamHealth } from "./features/hue/state/useHueStreamHealth";
import { useHueSolidBootstrapSync } from "./features/hue/state/useHueSolidBootstrapSync";
import { buildStatusItems } from "./features/shell/statusItems";
import { ShellNotices } from "./features/shell/ShellNotices";
import { OnboardingFlow } from "./features/onboarding/ui/OnboardingFlow";
import { useAutoUpdater } from "./features/updater/useAutoUpdater";
import { UpdateModal } from "./features/updater/UpdateModal";
import {
  shouldAutoOpenCalibrationOnConnection,
  startCalibrationFromSettings,
} from "./features/calibration/state/entryFlow";
import { useDeviceConnection } from "./features/device/useDeviceConnection";
import { useUsbTargetReconciler } from "./features/device/state/useUsbTargetReconciler";
import {
  canEnableLedMode,
  MODE_GUARD_REASONS,
} from "./features/mode/state/modeGuard";
import {
  LIGHTING_MODE_KIND,
  type LightingModeConfig,
} from "./features/mode/model/contracts";
import type { HueStartConfig } from "./features/hue/model/hueStartConfig";
import type { LedCalibrationConfig } from "./features/calibration/model/contracts";
import {
  resizeToMode,
  saveShellState,
} from "./features/shell/windowLifecycle";
import {
  useUIMode,
  UI_MODE_FADE_DURATION_MS,
  UI_MODE_FADE_TIMING,
} from "./features/shell/useUIMode";
import { useGlobalKeybinds } from "./features/shell/useGlobalKeybinds";
import {
  KEYBIND_ACTIONS,
  SECTION_IDS,
  type SectionId,
} from "./shared/contracts/shell";

/**
 * Marks that first-connect calibration has already been auto-opened. Session-scoped
 * so a WebView reload does not drop the user back into the editor unprompted.
 */
const CALIBRATION_AUTO_OPENED_KEY = "lumasync_calibration_opened";

function App() {
  const { t } = useTranslation();
  const { state: updaterState, checkForUpdates, downloadAndInstall, dismiss, devSetState: devSetUpdaterState } = useAutoUpdater();
  const {
    currentMode,
    isContentVisible,
    contentRef,
    switchUIMode,
    setCurrentMode,
  } = useUIMode();
  const [activeSection, setActiveSection] = useState<SectionId>(SECTION_IDS.LIGHTS);
  const [savedCalibration, setSavedCalibration] = useState<LedCalibrationConfig | undefined>(undefined);
  const [hueStartConfig, setHueStartConfig] = useState<HueStartConfig | null>(null);
  // Mirror of `hueStartConfig` so the connection-event subscriber (in a
  // useEffect with `[]` deps) can read the latest paired-bridge state
  // without re-subscribing on every state mutation.
  const hueStartConfigRef = useRef<HueStartConfig | null>(null);
  const { isConnected } = useDeviceConnection();
  const wasConnectedRef = useRef(false);
  // v1.5 W2-B4 — first-run onboarding state. The flag is hydrated from
  // shellStore on bootstrap; a fresh user (`undefined` / `false`) sees
  // the inline 3-step banner. \`hasInteractedWithMode\` flips true on
  // the first deliberate mode click after bootstrap so step 1 only
  // advances when the user actively engages.
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState<boolean>(true);
  const [hasInteractedWithMode, setHasInteractedWithMode] = useState(false);
  const autoOpenTriggeredRef = useRef(sessionStorage.getItem(CALIBRATION_AUTO_OPENED_KEY) === "1");
  // Auto-updater check is intentionally module-level (not inside the boot
  // sequence) so it fires immediately on mount and is not blocked by
  // shellStore / Hue / USB / DTLS work. The ref is a StrictMode dev-mode
  // guard: the underlying effect re-runs once during double-mount, this
  // ref short-circuits the second invocation so we always send exactly
  // one `check()` request to GitHub Releases.
  const updateCheckRanRef = useRef(false);

  const runtimeConfig = useModeRuntimeConfig({ calibration: savedCalibration });
  const { notice: hueColorNotice, report: reportHueSolidColorStatus } =
    useHueSolidColorNotice();

  const handleOpenCalibration = useCallback(() => {
    const entry = startCalibrationFromSettings(savedCalibration);
    if (entry.open) {
      setActiveSection(SECTION_IDS.LED_SETUP);
    }
  }, [savedCalibration]);

  const mode = useLightingModeOrchestrator({
    runtimeConfig,
    savedCalibration,
    hueStartConfig,
    setHueStartConfig,
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

  // Auto-updater poll — fires once on mount, in parallel with the boot
  // sequence. Previously lived at the tail of `bootstrap()` behind
  // shellStore + Hue validate + USB reconnect + DTLS handshake, which
  // pushed the GitHub Releases probe well past the user's first frame.
  // The ref guard absorbs StrictMode dev double-mount so we never
  // double-fire `check()`.
  useEffect(() => {
    if (updateCheckRanRef.current) return;
    updateCheckRanRef.current = true;
    void checkForUpdates();
  }, [checkForUpdates]);

  useHueStreamHealth({
    hueTargetSelected: selectedOutputTargets.includes("hue"),
    activeOutputTargetsRef: mode.activeOutputTargetsRef,
    lightingModeRef: mode.lightingModeRef,
    selectedOutputTargetsRef: mode.selectedOutputTargetsRef,
    dispatchRef: mode.dispatchRef,
    setActiveOutputTargets: mode.setActiveOutputTargets,
  });

  const hueStreaming = activeOutputTargets.includes("hue");
  const hueReachable = useHueBridgeReachability(hueStartConfig, hueStreaming);

  useHueSolidBootstrapSync({
    activeOutputTargets,
    lightingModeRef: mode.lightingModeRef,
    onAdoptSolid: mode.adoptSolidColor,
  });

  // The USB reconciler needs `bootstrapDone`, so it cannot be declared above
  // the boot sequence; arming reaches it through a ref rather than moving the
  // boot effect below every other effect.
  const armUsbConnectedRef = useRef<((connected: boolean) => void) | null>(null);
  const { bootstrapDone } = useShellBootstrap({
    t,
    setUIMode: setCurrentMode,
    setActiveSection,
    setSavedCalibration,
    setHasCompletedOnboarding,
    setHasInteractedWithMode,
    setLightingMode: mode.setLightingMode,
    setSelectedOutputTargets: mode.setSelectedOutputTargets,
    setActiveOutputTargets: mode.setActiveOutputTargets,
    setHueStartConfig,
    armUsbConnected: (connected) => armUsbConnectedRef.current?.(connected),
    runtimeConfig,
    reportHueSolidColorStatus,
  });

  const { usbDisconnectNotice, usbUnsupportedNotice, armUsbConnected } =
    useUsbTargetReconciler({
      isConnected,
      bootstrapDone,
      selectedOutputTargets,
      selectedOutputTargetsRef: mode.selectedOutputTargetsRef,
      hueStartConfigRef,
      onAutoAddUsbTarget: mode.setSelectedOutputTargets,
      onDropUsbTarget: handleOutputTargetsChange,
      onFallbackTargets: mode.setSelectedOutputTargets,
    });
  armUsbConnectedRef.current = armUsbConnected;

  useEffect(() => { hueStartConfigRef.current = hueStartConfig; }, [hueStartConfig]);
  useTrayIntegration({
    onLightingModeChange: handleLightingModeChange,
    lightingModeRef: mode.lightingModeRef,
    lastNonOffModeRef: mode.lastNonOffModeRef,
    selectedOutputTargetsRef: mode.selectedOutputTargetsRef,
    getSelectedDisplayId: runtimeConfig.getSelectedDisplayId,
  });

  const handleSectionChange = useCallback(async (sectionId: SectionId) => {
    // A3.5 — compact mode hosts only LIGHTS (CompactLayout ignores
    // activeSection). Without this gate, deep-link clicks from the
    // compact onboarding banner / CTA / tray menu would set
    // activeSection silently while the user still sees the LIGHTS
    // panel, leaving them with the "I clicked, nothing happened"
    // experience. Switching to full first surfaces the destination
    // section as the SettingsLayout fans out by activeSection.
    if (currentMode === "compact" && sectionId !== SECTION_IDS.LIGHTS) {
      try {
        await resizeToMode("full");
        setCurrentMode("full");
      } catch (err) {
        console.error("[LumaSync] resizeToMode(full) failed:", err);
      }
    }
    setActiveSection(sectionId);
    try {
      await saveShellState({ lastSection: sectionId });
    } catch (err) {
      console.error("[LumaSync] saveShellState(lastSection) failed:", err);
    }
  }, [currentMode, setCurrentMode]);

  // Auto-open calibration when device connects for the first time
  useEffect(() => {
    const shouldOpen = shouldAutoOpenCalibrationOnConnection({
      connected: isConnected,
      wasConnected: wasConnectedRef.current,
      hasCalibration: Boolean(savedCalibration),
      alreadyAutoOpened: autoOpenTriggeredRef.current,
    });

    if (shouldOpen) {
      autoOpenTriggeredRef.current = true;
      // The ref is seeded from this key on mount, so the write is what makes the
      // guard outlive a WebView reload.
      sessionStorage.setItem(CALIBRATION_AUTO_OPENED_KEY, "1");
      setActiveSection(SECTION_IDS.LED_SETUP);
    }

    wasConnectedRef.current = isConnected;
  }, [isConnected, savedCalibration]);


  // ---------------------------------------------------------------------------
  // Global keyboard shortcuts (G9 — launch-credibility fix).
  //
  // Every `<kbd>` cluster rendered by StatusBar / LightsSection comes from
  // `KEYBIND_REGISTRY`; here is where those badges become actual behaviour.
  // `useGlobalKeybinds` owns the document-level keydown listener and routes
  // each KeybindAction to the matching callback below. Disabling the hook
  // while a UI-mode fade is in flight keeps `⌥1/⌥2/⌥3` from firing during
  // the 180 ms cross-fade, where the lighting mode buttons would be invisible
  // anyway — pressing them mid-transition was the main feedback loop that
  // caused the "ghost mode flash" behaviour in preview builds.
  // ---------------------------------------------------------------------------
  const keybindHandlers = useMemo(
    () => ({
      [KEYBIND_ACTIONS.MODE_OFF]: () => {
        void handleLightingModeChange({ kind: LIGHTING_MODE_KIND.OFF });
      },
      [KEYBIND_ACTIONS.MODE_AMBILIGHT]: () => {
        void handleLightingModeChange({
          kind: LIGHTING_MODE_KIND.AMBILIGHT,
          ambilight: lightingMode.ambilight,
        });
      },
      [KEYBIND_ACTIONS.MODE_SOLID]: () => {
        void handleLightingModeChange({
          kind: LIGHTING_MODE_KIND.SOLID,
          solid: lightingMode.solid ?? { r: 255, g: 255, b: 255, brightness: 1 },
        });
      },
      [KEYBIND_ACTIONS.OPEN_SETTINGS]: () => {
        // ⌘, / Ctrl+, is the canonical "open settings" shortcut across
        // macOS / Linux / Windows desktop apps. Route to the System section
        // in full mode; if the user is in compact, switch to full first so
        // the settings surface is actually visible.
        if (currentMode === "compact") {
          switchUIMode("full");
        }
        void handleSectionChange(SECTION_IDS.SYSTEM);
      },
    }),
    [
      handleLightingModeChange,
      handleSectionChange,
      switchUIMode,
      currentMode,
      lightingMode.ambilight,
      lightingMode.solid,
    ],
  );

  useGlobalKeybinds(keybindHandlers, { disabled: !isContentVisible });

  const hotReload = useModeHotReload(runtimeConfig, mode.dispatch, lightingMode);

  const modeGuard = canEnableLedMode(savedCalibration, selectedOutputTargets);

  // Shared SettingsLayout props — only `uiMode` differs between the
  // outgoing and incoming cross-fade slots.
  const sharedSettingsLayoutProps = {
    activeSection,
    onSectionChange: handleSectionChange,
    calibration: savedCalibration,
    lightingMode,
    outputTargets: selectedOutputTargets,
    usbConnected: isConnected,
    hueConfigured: hueStartConfig !== null,
    hueReachable: hueReachable || hueStreaming,
    hueStreaming,
    modeLockReason:
      modeGuard.reason === MODE_GUARD_REASONS.CALIBRATION_REQUIRED
        ? modeGuard.reason
        : null,
    isModeTransitioning,
    onLightingModeChange: (next: LightingModeConfig) => {
      // v1.5 W2-B4 — first deliberate mode click satisfies the LIGHTS
      // step guard. Subsequent clicks are no-ops on the flag.
      if (!hasInteractedWithMode) setHasInteractedWithMode(true);
      handleLightingModeChange(next);
    },
    onOutputTargetsChange: handleOutputTargetsChange,
    onCalibrationSaved: (config: LedCalibrationConfig) => {
      setSavedCalibration(config);
      // Prime the ref synchronously so any set_lighting_mode dispatch
      // that fires before the next effect flush carries the new
      // calibration's totalLeds. Without this, a calibration save
      // followed by an immediate mode toggle could race and ship the
      // prior totalLeds.
      runtimeConfig.setCalibration(config);
    },
    onCheckForUpdates: checkForUpdates,
    isCheckingForUpdates: updaterState.status === "checking",
    devSetUpdaterState,
    ...hotReload,
    // v1.5 W2-B1 — compact-mode "no reachable output" banner deep-link.
    // The full-mode shell already exposes DEVICES through the sidebar, so
    // this prop is consumed exclusively by `<CompactLayout>`.
    onOpenDevices: () => void handleSectionChange(SECTION_IDS.DEVICES),
  } as const;

  // v1.5 W2-B4 — onboarding completion handler. Persists the flag and
  // unmounts the flow on the next render. Called on either a successful
  // step 3 (calibration saved) or a deliberate dismiss.
  const handleOnboardingComplete = useCallback(() => {
    setHasCompletedOnboarding(true);
    void saveShellState({ hasCompletedOnboarding: true }).catch((err) => {
      console.error("[LumaSync] saveShellState(hasCompletedOnboarding) failed:", err);
    });
  }, []);

  const openDevicesSection = () => void handleSectionChange(SECTION_IDS.DEVICES);

  const statusItems = buildStatusItems(
    {
      ambilightActive: lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT,
      usbConnected: isConnected,
      hueStreaming,
      hueReachable,
      hueConfigured: hueStartConfig !== null,
      onOpenDevices: openDevicesSection,
    },
    t,
  );
  const statusBarHeight = statusBarHeightPx(currentMode);

  return (
    <>
      {/* Custom cross-platform title bar. Sits above everything. Handles
          native drag + double-click zoom, hosts the compact-mode toggle, and
          (on Windows/Linux) draws custom min/max/close buttons since native
          decorations are disabled there. See TitleBar.tsx for details. */}
      <TitleBar
        uiMode={currentMode}
        onSwitchUIMode={switchUIMode}
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
        <div
          ref={contentRef}
          className={`absolute inset-0 ${
            isContentVisible ? "" : "pointer-events-none"
          }`}
          style={{
            opacity: isContentVisible ? 1 : 0,
            // Soft "materialize" — on fade-out the content subtly recedes
            // (scale down + slight blur) and on fade-in it settles back in
            // place. Paired with the matched backdrop color this replaces
            // the "content disappears" feeling with a gentle breathe.
            transform: isContentVisible ? "scale(1)" : "scale(0.985)",
            filter: isContentVisible ? "blur(0px)" : "blur(6px)",
            transformOrigin: "center center",
            willChange: "opacity, transform, filter",
            transitionProperty: "opacity, transform, filter",
            transitionDuration: `${UI_MODE_FADE_DURATION_MS}ms`,
            transitionTimingFunction: UI_MODE_FADE_TIMING,
          }}
        >
          <OnboardingFlow
            hasCompleted={hasCompletedOnboarding}
            guards={{
              hasInteractedWithMode,
              hasReachableOutput: isConnected || hueReachable || hueStreaming,
              hasSavedCalibration: savedCalibration !== undefined,
            }}
            onOpenLights={() => void handleSectionChange(SECTION_IDS.LIGHTS)}
            onOpenDevices={() => void handleSectionChange(SECTION_IDS.DEVICES)}
            onOpenCalibration={() => void handleSectionChange(SECTION_IDS.LED_SETUP)}
            onComplete={handleOnboardingComplete}
          />
          <SettingsLayout uiMode={currentMode} {...sharedSettingsLayoutProps} />
        </div>
      </div>
      <StatusBar
        items={statusItems}
        uiMode={currentMode}
        lightingActive={lightingMode.kind !== LIGHTING_MODE_KIND.OFF}
      />
      <UpdateModal
        state={updaterState}
        onInstall={downloadAndInstall}
        onDismiss={dismiss}
        onRetry={() => void checkForUpdates()}
      />
      <ShellNotices
        usbDisconnected={usbDisconnectNotice}
        usbUnsupported={usbUnsupportedNotice}
        stopFailedTargets={mode.stopFailedNotice}
        hueColorNotice={hueColorNotice}
      />
    </>
  );
}

export default App;
