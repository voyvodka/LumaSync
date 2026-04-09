/**
 * App.tsx — Settings shell bootstrap
 *
 * Mounts the SettingsLayout, manages active section state,
 * and bridges shell persistence (window lifecycle + section restore).
 */

// DEV PREVIEW — uncomment + comment out "export default App" below to preview
// import { HueAreaPreview } from "./dev/HueAreaPreview";
// export { HueAreaPreview as default };

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { SettingsLayout } from "./features/settings/SettingsLayout";
import { useAutoUpdater } from "./features/updater/useAutoUpdater";
import { UpdateModal } from "./features/updater/UpdateModal";
import {
  shouldAutoOpenCalibrationOnConnection,
  startCalibrationFromSettings,
  type CalibrationOverlayStep,
} from "./features/calibration/state/entryFlow";
import { useDeviceConnection } from "./features/device/useDeviceConnection";
import {
  canEnableLedMode,
  MODE_GUARD_REASONS,
} from "./features/mode/state/modeGuard";
import {
  LIGHTING_MODE_KIND,
  normalizeLightingModeConfig,
  type LightingModeConfig,
} from "./features/mode/model/contracts";
import {
  getHueStreamStatus,
  setHueSolidColor,
  setLightingMode,
  startHue,
  stopLighting,
  stopHue,
} from "./features/mode/modeApi";
import { validateHueCredentials } from "./features/device/hueOnboardingApi";
import {
  applyRuntimeResultToTargets,
  resolveHueRuntimePlan,
  type HueTargetCommandResult,
} from "./features/mode/state/hueModeRuntimeFlow";
import {
  normalizeLedCalibrationConfig,
  type LedCalibrationConfig,
} from "./features/calibration/model/contracts";
import {
  initWindowLifecycle,
  loadShellState,
  saveShellState,
} from "./features/shell/windowLifecycle";
import {
  SECTION_IDS,
  type SectionId,
} from "./shared/contracts/shell";
import { HUE_RUNTIME_STATES, HUE_STATUS, type HueRuntimeTarget } from "./shared/contracts/hue";
import { DEVICE_COMMANDS } from "./shared/contracts/device";
import {
  listenTrayLightsOff,
  listenTrayResumeLastMode,
  listenTraySolidColor,
  updateTrayLabels,
} from "./features/tray/trayController";
import { i18next } from "./features/i18n/i18n";

const DEFAULT_OUTPUT_TARGETS: HueRuntimeTarget[] = ["usb"];
const LIGHTING_MODE_PERSIST_DEBOUNCE_MS = 300;
/** Interval for polling backend Hue stream health when "hue" is an active output target. */
const HUE_STREAM_HEALTH_POLL_MS = 5_000;
/** Interval for checking bridge reachability when configured but stream is not active. */
const HUE_BRIDGE_REACHABILITY_POLL_MS = 30_000;

interface HueStartConfig {
  bridgeIp: string;
  username: string;
  clientKey: string;
  areaId: string;
}

function normalizeOutputTargets(value: unknown): HueRuntimeTarget[] {
  if (!Array.isArray(value)) return [...DEFAULT_OUTPUT_TARGETS];
  const targetSet = new Set(
    value.filter((t): t is HueRuntimeTarget => t === "usb" || t === "hue"),
  );
  if (targetSet.size === 0) return [...DEFAULT_OUTPUT_TARGETS];
  return ["usb", "hue"].filter((t): t is HueRuntimeTarget => targetSet.has(t as HueRuntimeTarget));
}

function toHueStartConfig(state: {
  lastHueBridge?: { ip: string };
  hueAppKey?: string;
  hueClientKey?: string;
  lastHueAreaId?: string;
}): HueStartConfig | null {
  const bridgeIp = state.lastHueBridge?.ip?.trim();
  const username = state.hueAppKey?.trim();
  const clientKey = state.hueClientKey?.trim() ?? "";
  const areaId = state.lastHueAreaId?.trim();
  if (!bridgeIp || !username || !areaId) return null;
  return { bridgeIp, username, clientKey, areaId };
}

function isHueStartCodeOk(code: string): boolean {
  return (
    code === "HUE_STREAM_RUNNING" ||
    code === "HUE_STREAM_RUNNING_DTLS" ||
    code === "HUE_STREAM_STARTING" ||
    code === "HUE_START_NOOP_ALREADY_ACTIVE"
  );
}

function isHueStopCodeOk(code: string): boolean {
  return code === "HUE_STREAM_STOPPED";
}

function isSameTargetSet(a: HueRuntimeTarget[], b: HueRuntimeTarget[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((t) => set.has(t));
}

function App() {
  const { t } = useTranslation("common");
  const { state: updaterState, checkForUpdates, downloadAndInstall, dismiss } = useAutoUpdater();
  const [activeSection, setActiveSection] = useState<SectionId>(SECTION_IDS.LIGHTS);
  const [savedCalibration, setSavedCalibration] = useState<LedCalibrationConfig | undefined>(undefined);
  const [calibrationStep, setCalibrationStep] = useState<CalibrationOverlayStep>("editor");
  const [lightingMode, setLightingModeState] = useState<LightingModeConfig>({ kind: LIGHTING_MODE_KIND.OFF });
  const [selectedOutputTargets, setSelectedOutputTargets] = useState<HueRuntimeTarget[]>([...DEFAULT_OUTPUT_TARGETS]);
  const [activeOutputTargets, setActiveOutputTargets] = useState<HueRuntimeTarget[]>([]);
  const [hueStartConfig, setHueStartConfig] = useState<HueStartConfig | null>(null);
  const [hueReachable, setHueReachable] = useState(false);
  const [isModeTransitioning, setIsModeTransitioning] = useState(false);
  const { isConnected } = useDeviceConnection();
  const wasConnectedRef = useRef(false);
  // Hot-plug detection refs/state — separate from wasConnectedRef (per Pitfall 4)
  const prevUsbConnectedRef = useRef<boolean | null>(null); // null = not yet initialized
  const [bootstrapDone, setBootstrapDone] = useState(false);
  const [showUsbSuggest, setShowUsbSuggest] = useState(false);
  const [usbDisconnectNotice, setUsbDisconnectNotice] = useState(false);
  const autoOpenTriggeredRef = useRef(sessionStorage.getItem("lumasync_calibration_opened") === "1");
  const modeTransitionLockRef = useRef(false);
  const bootstrapRanRef = useRef(false);
  const pendingModeChangeRef = useRef<LightingModeConfig | null>(null);
  const persistLightingModeTimeoutRef = useRef<number | null>(null);
  const activeOutputTargetsRef = useRef<HueRuntimeTarget[]>([]);
  // Tray quick-action refs — always hold latest values for use in stable listeners
  const lightingModeRef = useRef<LightingModeConfig>(lightingMode);
  const lastNonOffModeRef = useRef<LightingModeConfig | null>(null);
  const selectedOutputTargetsRef = useRef<HueRuntimeTarget[]>(selectedOutputTargets);
  /**
   * hueSolidSyncedRef — "Bootstrap solid color sync" bayrağı.
   * Hue Running state'e her girişte bir kez lastSolidColor push edilir,
   * ardından true yapılır. Running dışına çıkınca false sıfırlanır.
   * Kullanıcı renk değiştirirken bu bayrak DOKUNULMAZ — loop'u önler.
   */
  const hueSolidSyncedRef = useRef(false);

  const scheduleLightingModePersist = useCallback((mode: LightingModeConfig) => {
    if (persistLightingModeTimeoutRef.current !== null) {
      window.clearTimeout(persistLightingModeTimeoutRef.current);
      persistLightingModeTimeoutRef.current = null;
    }
    persistLightingModeTimeoutRef.current = window.setTimeout(() => {
      persistLightingModeTimeoutRef.current = null;
      void saveShellState({ lightingMode: mode });
    }, LIGHTING_MODE_PERSIST_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (persistLightingModeTimeoutRef.current !== null) {
        window.clearTimeout(persistLightingModeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    activeOutputTargetsRef.current = activeOutputTargets;
  }, [activeOutputTargets]);

  // ---------------------------------------------------------------------------
  // B2 fix: Poll backend Hue stream health while "hue" is an active target.
  // When the backend reports Failed or Idle, remove "hue" from activeOutputTargets
  // so the frontend chip stops pulsing and accurately reflects the dead stream.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!activeOutputTargets.includes("hue")) return;

    let active = true;

    const poll = async () => {
      if (!active) return;
      try {
        const result = await getHueStreamStatus();
        if (!active) return;
        const backendDead =
          result.status.state === HUE_RUNTIME_STATES.FAILED ||
          result.status.state === HUE_RUNTIME_STATES.IDLE;
        if (backendDead) {
          setActiveOutputTargets((prev) => prev.filter((t) => t !== "hue"));
        }
      } catch {
        // Network error polling status — do not remove target on transient fetch failure.
      }
    };

    void poll();
    const intervalId = window.setInterval(() => { void poll(); }, HUE_STREAM_HEALTH_POLL_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [activeOutputTargets]);

  // ---------------------------------------------------------------------------
  // Bridge reachability poll: validate credentials every 30 s when hue is
  // configured but stream is NOT active. Updates hueReachable so the chip
  // accurately reflects whether the bridge is currently on the same network.
  // While hue is streaming we skip polling — the active stream is proof enough.
  // ---------------------------------------------------------------------------
  const hueStreaming = activeOutputTargets.includes("hue");
  useEffect(() => {
    if (!hueStartConfig || hueStreaming) return;

    let active = true;

    const poll = async () => {
      if (!active) return;
      try {
        const validation = await validateHueCredentials(
          hueStartConfig.bridgeIp,
          hueStartConfig.username,
          hueStartConfig.clientKey,
        );
        if (!active) return;
        setHueReachable(validation.status.code === HUE_STATUS.CREDENTIAL_VALID);
      } catch {
        if (active) setHueReachable(false);
      }
    };

    const intervalId = window.setInterval(() => { void poll(); }, HUE_BRIDGE_REACHABILITY_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [hueStartConfig, hueStreaming]);

  // ---------------------------------------------------------------------------
  // Hue solid color bootstrap sync (Hue → UI yönünde okuma).
  //
  // Hue Running'e her girişte BİR KEZ backend'den lastSolidColor okunur:
  //   - "hue" activeOutputTargets'a girince VE hueSolidSyncedRef false ise
  //     → getHueStreamStatus() çağır → lastSolidColor varsa
  //       → setLightingModeState({ kind: SOLID, solid: lastSolidColor }) yap.
  //     → bayrağı true yap (loop'u önler).
  //   - "hue" activeOutputTargets'tan çıkınca (stop/fail)
  //     → bayrağı false sıfırla (sonraki bağlantı için hazırla).
  //
  // Kullanıcı renk değiştirince (isQuickSolidAdjustment yolu) bu bayrak
  // DOKUNULMAZ — bu sayede UI'dan gelen değişiklik backend'den override edilmez.
  // ---------------------------------------------------------------------------
  const prevHueActiveRef = useRef(false);
  useEffect(() => {
    const hueNowActive = activeOutputTargets.includes("hue");

    if (!hueNowActive && prevHueActiveRef.current) {
      // Hue Running → başka state: bayrağı sıfırla
      hueSolidSyncedRef.current = false;
    }

    if (hueNowActive && !hueSolidSyncedRef.current) {
      // Hue Running'e yeni girdi ve henüz sync yapılmadı
      hueSolidSyncedRef.current = true;
      void getHueStreamStatus()
        .then((result) => {
          const snap = result.lastSolidColor;
          if (snap) {
            setLightingModeState({
              kind: LIGHTING_MODE_KIND.SOLID,
              solid: {
                r: snap.r,
                g: snap.g,
                b: snap.b,
                brightness: snap.brightness,
              },
            });
          }
        })
        .catch((error) => {
          console.error("[LumaSync] Bootstrap solid color read failed:", error);
          // Başarısız olursa sonraki bağlantıda tekrar denensin
          hueSolidSyncedRef.current = false;
        });
    }

    prevHueActiveRef.current = hueNowActive;
  }, [activeOutputTargets]);

  useEffect(() => {
    // StrictMode guard: prevent double bootstrap in dev mode.
    // React.StrictMode unmounts/remounts, running the effect twice.
    // A ref guard ensures only the first invocation proceeds.
    if (bootstrapRanRef.current) return;
    bootstrapRanRef.current = true;
    async function bootstrap() {
      try {
        // Restore window geometry immediately — before any heavy async work —
        // so the window settles into its saved position without a visible jump.
        await initWindowLifecycle({
          onFirstCloseToTray: () => {
            console.info(
              "[LumaSync] Hint: The app is still running in the system tray. " +
              "Click the tray icon to reopen settings.",
            );
          },
        });

        const state = await loadShellState();
        // Map old section IDs to new ones for backward compatibility
        const sectionMap: Record<string, SectionId> = {
          // Legacy IDs from persisted state before navigation restructure
          general: SECTION_IDS.LIGHTS,
          control: SECTION_IDS.LIGHTS,
          calibration: SECTION_IDS.LED_SETUP,
          device: SECTION_IDS.DEVICES,
          settings: SECTION_IDS.SYSTEM,
          "startup-tray": SECTION_IDS.SYSTEM,
          language: SECTION_IDS.SYSTEM,
          "about-logs": SECTION_IDS.SYSTEM,
          telemetry: SECTION_IDS.SYSTEM,
          // Current IDs (map to themselves)
          lights: SECTION_IDS.LIGHTS,
          "led-setup": SECTION_IDS.LED_SETUP,
          devices: SECTION_IDS.DEVICES,
          system: SECTION_IDS.SYSTEM,
        };
        // On first launch keep the default LIGHTS section.
        // On a page refresh (sessionStorage survives the reload) restore the last section.
        const isPageRefresh = sessionStorage.getItem("lumasync_session") === "1";
        sessionStorage.setItem("lumasync_session", "1");

        if (isPageRefresh) {
          const mappedSection = sectionMap[state.lastSection] ?? SECTION_IDS.LIGHTS;
          setActiveSection(mappedSection);
        }
        setSavedCalibration(normalizeLedCalibrationConfig(state.ledCalibration));
        const restoredMode = normalizeLightingModeConfig(state.lightingMode);
        const restoredTargets = normalizeOutputTargets(state.lastOutputTargets);
        setLightingModeState(restoredMode);

        // D-09: Filter persisted targets against available hardware at startup
        let bootstrapUsbAvailable = false;
        try {
          const connectionStatus = await invoke<{ connected: boolean }>(
            DEVICE_COMMANDS.GET_CONNECTION_STATUS,
          );
          bootstrapUsbAvailable = connectionStatus.connected;
          const filteredTargets = restoredTargets.filter(
            (t) => t !== "usb" || bootstrapUsbAvailable,
          );
          setSelectedOutputTargets(filteredTargets.length > 0 ? filteredTargets : restoredTargets);
        } catch {
          // If status check fails, use restored targets as-is
          setSelectedOutputTargets(restoredTargets);
        }

        // Initialize hot-plug ref AFTER USB status is known
        // This prevents false "USB detected" events on startup
        prevUsbConnectedRef.current = bootstrapUsbAvailable;

        const isActive = restoredMode.kind !== LIGHTING_MODE_KIND.OFF;
        setActiveOutputTargets(isActive ? restoredTargets : []);
        const hueBootstrapConfig = toHueStartConfig(state);
        setHueStartConfig(hueBootstrapConfig);

        if (hueBootstrapConfig) {
          try {
            const validation = await validateHueCredentials(
              hueBootstrapConfig.bridgeIp,
              hueBootstrapConfig.username,
              hueBootstrapConfig.clientKey,
            );
            setHueReachable(validation.status.code === HUE_STATUS.CREDENTIAL_VALID);
          } catch {
            setHueReachable(false);
          }
        }

        if (isActive && restoredTargets.includes("hue") && hueBootstrapConfig) {
          try {
            const startResult = await startHue(hueBootstrapConfig);
            if (isHueStartCodeOk(startResult.status.code)) {
              if (
                restoredMode.kind === LIGHTING_MODE_KIND.SOLID &&
                restoredMode.solid
              ) {
                await setHueSolidColor({
                  r: restoredMode.solid.r,
                  g: restoredMode.solid.g,
                  b: restoredMode.solid.b,
                  brightness: restoredMode.solid.brightness,
                });
              } else if (restoredMode.kind === LIGHTING_MODE_KIND.AMBILIGHT) {
                // Use filtered targets (USB removed if not connected) so the
                // backend USB gate doesn't block Hue-only ambilight at startup.
                const bootTargets = restoredTargets.filter(
                  (t) => t !== "usb" || bootstrapUsbAvailable,
                );
                await setLightingMode({
                  ...restoredMode,
                  targets: bootTargets,
                });
              }
            }
          } catch { }
        }

        // Check for updates silently after startup
        void checkForUpdates();

        // Push localized tray labels to Rust
        void updateTrayLabels({
          openSettings: i18next.t("tray.openSettings"),
          lightsOff: i18next.t("tray.lightsOff"),
          resumeLastMode: i18next.t("tray.resumeLastMode"),
          solidColor: i18next.t("tray.solidColor"),
          quit: i18next.t("tray.quit"),
        });

        // Mark bootstrap complete — hot-plug useEffect may now run
        setBootstrapDone(true);
      } catch (err) {
        console.warn("[LumaSync] Shell lifecycle bootstrap error:", err);
        // Still mark bootstrap complete so UI is not permanently blocked
        setBootstrapDone(true);
      }
    }

    bootstrap();
  }, []);

  // Keep tray refs in sync with latest state
  useEffect(() => { lightingModeRef.current = lightingMode; }, [lightingMode]);
  useEffect(() => { selectedOutputTargetsRef.current = selectedOutputTargets; }, [selectedOutputTargets]);
  useEffect(() => {
    if (lightingMode.kind !== LIGHTING_MODE_KIND.OFF) {
      lastNonOffModeRef.current = lightingMode;
    }
  }, [lightingMode]);

  // Register i18n languageChanged hook to re-push tray labels
  useEffect(() => {
    const handler = () => {
      void updateTrayLabels({
        openSettings: i18next.t("tray.openSettings"),
        lightsOff: i18next.t("tray.lightsOff"),
        resumeLastMode: i18next.t("tray.resumeLastMode"),
        solidColor: i18next.t("tray.solidColor"),
        quit: i18next.t("tray.quit"),
      });
    };
    i18next.on("languageChanged", handler);
    return () => { i18next.off("languageChanged", handler); };
  }, []);

  // Tray quick action listeners (registered once, use refs for fresh state)
  const handleLightingModeChangeRef = useRef<((m: LightingModeConfig) => Promise<void>) | null>(null);

  useEffect(() => {
    let unlistenOff: (() => void) | null = null;
    let unlistenResume: (() => void) | null = null;
    let unlistenSolid: (() => void) | null = null;

    void Promise.all([
      listenTrayLightsOff(() => {
        const handler = handleLightingModeChangeRef.current;
        if (handler) void handler({ kind: LIGHTING_MODE_KIND.OFF });
      }),
      listenTrayResumeLastMode(() => {
        const handler = handleLightingModeChangeRef.current;
        const mode = lastNonOffModeRef.current ?? lightingModeRef.current;
        if (handler && mode.kind !== LIGHTING_MODE_KIND.OFF) {
          void handler({ ...mode, targets: selectedOutputTargetsRef.current });
        }
      }),
      listenTraySolidColor(() => {
        const handler = handleLightingModeChangeRef.current;
        const currentMode = lightingModeRef.current;
        if (handler) {
          void handler({
            kind: LIGHTING_MODE_KIND.SOLID,
            solid: currentMode.solid ?? { r: 255, g: 255, b: 255, brightness: 1 },
            targets: selectedOutputTargetsRef.current,
          });
        }
      }),
    ]).then(([u1, u2, u3]) => {
      unlistenOff = u1;
      unlistenResume = u2;
      unlistenSolid = u3;
    });

    return () => {
      unlistenOff?.();
      unlistenResume?.();
      unlistenSolid?.();
    };
  }, []);

  const handleSectionChange = useCallback(async (sectionId: SectionId) => {
    setActiveSection(sectionId);
    try { await saveShellState({ lastSection: sectionId }); } catch { }
  }, []);

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
      setCalibrationStep("template");
      setActiveSection(SECTION_IDS.LED_SETUP);
    }

    wasConnectedRef.current = isConnected;
  }, [isConnected, savedCalibration]);

  const handleOpenCalibration = useCallback(() => {
    const entry = startCalibrationFromSettings(savedCalibration);
    if (entry.open) {
      setCalibrationStep(entry.step);
      setActiveSection(SECTION_IDS.LED_SETUP);
    }
  }, [savedCalibration]);

  const handleOutputTargetsChange = useCallback(async (targets: HueRuntimeTarget[]) => {
    const normalizedTargets = normalizeOutputTargets(targets);
    const prevTargets = selectedOutputTargets;
    setSelectedOutputTargets(normalizedTargets);
    try { await saveShellState({ lastOutputTargets: normalizedTargets }); } catch { }

    // Delta logic — only when a mode is actively running (not OFF)
    if (lightingMode.kind === LIGHTING_MODE_KIND.OFF) return;

    const currentActive = activeOutputTargetsRef.current;
    const addedTargets = normalizedTargets.filter((t) => !prevTargets.includes(t));
    const removedTargets = prevTargets.filter((t) => !normalizedTargets.includes(t));

    // Delta-stop: for each removed target that is currently active, stop it
    for (const target of removedTargets) {
      if (!currentActive.includes(target)) continue;
      if (target === "usb") {
        try { await invoke("stop_lighting"); } catch { }
      }
      if (target === "hue") {
        try { await invoke("stop_hue_stream"); } catch { }
      }
    }
    // Update activeOutputTargets by removing stopped targets
    if (removedTargets.length > 0) {
      const nextActive = currentActive.filter((t) => !removedTargets.includes(t));
      setActiveOutputTargets(nextActive);
    }

    // Delta-start: for each added target, start the current mode on it
    for (const target of addedTargets) {
      if (target === "usb") {
        // Note: was previously using invoke("set_lighting_mode", { request: {...} })
        // which is the wrong key name (Tauri expects "payload") and silently failed.
        try {
          await setLightingMode({
            kind: lightingMode.kind,
            solid: lightingMode.solid,
            ambilight: lightingMode.ambilight,
            targets: normalizedTargets,
          });
          setActiveOutputTargets((prev) => [...new Set([...prev, "usb" as HueRuntimeTarget])]);
        } catch {
          // D-06: silently skip failed target, existing targets continue
          console.warn("[seamless-switch] USB delta-start failed, skipping");
        }
      }
      if (target === "hue") {
        try {
          const latestShellState = await loadShellState();
          const runtimeHueConfig = toHueStartConfig(latestShellState) ?? hueStartConfig;
          if (!runtimeHueConfig) {
            console.warn("[seamless-switch] Hue delta-start skipped — no bridge config");
            continue;
          }
          const hueResult = await startHue(runtimeHueConfig);
          if (isHueStartCodeOk(hueResult.status.code)) {
            setActiveOutputTargets((prev) => [...new Set([...prev, "hue" as HueRuntimeTarget])]);
            // Re-apply lighting mode so the ambilight worker picks up the now-live
            // Hue stream context. Without this, the running worker has hue_output=None
            // and never sends colors to Hue (solid color push handles SOLID mode too).
            try {
              await setLightingMode({
                kind: lightingMode.kind,
                solid: lightingMode.solid,
                ambilight: lightingMode.ambilight,
                targets: normalizedTargets,
              });
            } catch {
              // Non-fatal for ambilight worker restart; fall through to solid push
            }
            if (lightingMode.kind === LIGHTING_MODE_KIND.SOLID && lightingMode.solid) {
              try {
                await setHueSolidColor({
                  r: lightingMode.solid.r,
                  g: lightingMode.solid.g,
                  b: lightingMode.solid.b,
                  brightness: lightingMode.solid.brightness,
                });
              } catch { /* non-fatal */ }
            }
          }
        } catch {
          // D-06: silently skip failed target, existing targets continue
          console.warn("[seamless-switch] Hue delta-start failed, skipping");
        }
      }
    }
  }, [lightingMode, selectedOutputTargets, hueStartConfig]);

  // ---------------------------------------------------------------------------
  // Hot-plug detection: USB plug/unplug target management (D-07, D-08)
  // Guard: only runs after bootstrap has initialized prevUsbConnectedRef
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!bootstrapDone) return; // Skip until bootstrap sets ref and flag

    const wasConnected = prevUsbConnectedRef.current;

    if (wasConnected === false && isConnected) {
      // USB just plugged in (D-07) — offer to add as target
      if (!selectedOutputTargets.includes("usb")) {
        setShowUsbSuggest(true);
        // Auto-dismiss after 10 seconds
        window.setTimeout(() => setShowUsbSuggest(false), 10_000);
      }
    }

    if (wasConnected === true && !isConnected) {
      // USB just unplugged (D-08) — silently drop from targets
      if (selectedOutputTargets.includes("usb")) {
        const nextTargets = selectedOutputTargets.filter((t) => t !== "usb");
        if (nextTargets.length > 0) {
          void handleOutputTargetsChange(nextTargets);
          setUsbDisconnectNotice(true);
          window.setTimeout(() => setUsbDisconnectNotice(false), 5_000);
        }
        // If no targets remain, keep current targets — mode buttons will show disabled via guard
      }
      setShowUsbSuggest(false);
    }

    prevUsbConnectedRef.current = isConnected;
  }, [isConnected, selectedOutputTargets, handleOutputTargetsChange, bootstrapDone]);

  const handleAcceptUsbTarget = useCallback(async () => {
    setShowUsbSuggest(false);
    if (!selectedOutputTargets.includes("usb")) {
      await handleOutputTargetsChange([...selectedOutputTargets, "usb"]);
    }
  }, [selectedOutputTargets, handleOutputTargetsChange]);

  const handleDismissUsbSuggest = useCallback(() => {
    setShowUsbSuggest(false);
  }, []);

  const handleLightingModeChange = useCallback(
    async (nextMode: LightingModeConfig) => {
      if (modeTransitionLockRef.current) {
        pendingModeChangeRef.current = nextMode;
        return;
      }

      modeTransitionLockRef.current = true;

      const normalizedNextMode = normalizeLightingModeConfig({
        kind: nextMode.kind,
        solid: nextMode.solid ?? lightingMode.solid,
        ambilight: nextMode.ambilight ?? lightingMode.ambilight,
        targets: selectedOutputTargets,
      });
      const isQuickSolidAdjustment =
        normalizedNextMode.kind === LIGHTING_MODE_KIND.SOLID &&
        lightingMode.kind === LIGHTING_MODE_KIND.SOLID &&
        isSameTargetSet(selectedOutputTargets, activeOutputTargets);

      if (isQuickSolidAdjustment && normalizedNextMode.solid) {
        setLightingModeState(normalizedNextMode);
        scheduleLightingModePersist(normalizedNextMode);

        if (activeOutputTargets.includes("usb")) {
          void setLightingMode(normalizedNextMode).catch((error) => {
            console.error("[LumaSync] Failed to push USB solid update:", error);
          });
        }

        if (activeOutputTargets.includes("hue")) {
          void setHueSolidColor({
            r: normalizedNextMode.solid.r,
            g: normalizedNextMode.solid.g,
            b: normalizedNextMode.solid.b,
            brightness: normalizedNextMode.solid.brightness,
          }).catch((error) => {
            console.error("[LumaSync] Failed to push Hue solid update:", error);
          });
        }

        modeTransitionLockRef.current = false;
        return;
      }

      if (!isQuickSolidAdjustment) setIsModeTransitioning(true);

      // D-05: USB target requires calibration; Hue-only does not
      const usesUsb = selectedOutputTargets.includes("usb");
      const requiresCalibration =
        usesUsb && !savedCalibration && normalizedNextMode.kind !== LIGHTING_MODE_KIND.OFF;

      if (requiresCalibration) {
        handleOpenCalibration();
        modeTransitionLockRef.current = false;
        setIsModeTransitioning(false);
        return;
      }

      try {
        const latestShellState = await loadShellState();
        const runtimeHueStartConfig = toHueStartConfig(latestShellState) ?? hueStartConfig;
        setHueStartConfig(runtimeHueStartConfig);

        if (normalizedNextMode.kind === LIGHTING_MODE_KIND.OFF) {
          const runtimePlan = resolveHueRuntimePlan({
            action: "stop",
            selectedTargets: selectedOutputTargets,
            activeTargets: activeOutputTargets,
            userInitiated: true,
            reconnectingTargets: activeOutputTargets,
          });

          const targetResults: Partial<Record<HueRuntimeTarget, HueTargetCommandResult>> = {};
          for (const target of runtimePlan.stopTargets) {
            if (target === "usb") { await stopLighting(); targetResults.usb = { ok: true }; }
            if (target === "hue") {
              const hueResult = await stopHue();
              targetResults.hue = {
                ok: isHueStopCodeOk(hueResult.status.code),
                code: hueResult.status.code,
                message: hueResult.status.message,
              };
            }
          }

          const shouldForceHueStop =
            !targetResults.hue &&
            (activeOutputTargets.includes("hue") ||
              selectedOutputTargets.includes("hue") ||
              Boolean(runtimeHueStartConfig));

          if (shouldForceHueStop) {
            try {
              const hueResult = await stopHue();
              targetResults.hue = {
                ok: isHueStopCodeOk(hueResult.status.code),
                code: hueResult.status.code,
                message: hueResult.status.message,
              };
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              targetResults.hue = { ok: false, code: "HUE_STOP_FAILED", message: reason };
            }
          }

          const merged = applyRuntimeResultToTargets(runtimePlan, targetResults);
          setActiveOutputTargets(merged.activeTargets);
          setLightingModeState(normalizedNextMode);
          scheduleLightingModePersist(normalizedNextMode);
          return;
        }

        const runtimePlan = resolveHueRuntimePlan({
          action: "start",
          selectedTargets: selectedOutputTargets,
          activeTargets: activeOutputTargets,
        });

        const targetResults: Partial<Record<HueRuntimeTarget, HueTargetCommandResult>> = {};

        // Phase 1: Start Hue streaming session FIRST.
        // setLightingMode (Phase 2) calls snapshot_hue_output_context() on the backend,
        // which must find an active stream to hand the ambilight worker a valid Hue context.
        // Calling startHue after setLightingMode would leave hue_output=None in the worker.
        if (runtimePlan.startTargets.includes("hue")) {
          if (!runtimeHueStartConfig) {
            targetResults.hue = {
              ok: false,
              code: "CONFIG_NOT_READY_GATE_BLOCKED",
              message: "Hue start requires bridge, credential, and area configuration.",
            };
          } else {
            try {
              const hueResult = await startHue(runtimeHueStartConfig);
              targetResults.hue = {
                ok: isHueStartCodeOk(hueResult.status.code),
                code: hueResult.status.code,
                message: hueResult.status.message,
              };
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              targetResults.hue = { ok: false, code: "HUE_MODE_APPLY_FAILED", message: reason };
            }
          }
        }

        // Phase 2: Apply lighting mode to backend.
        // Runs when: USB target is requested, OR Hue target started successfully.
        // For Hue-only targets this call starts the ambilight worker (which was
        // previously never called, leaving the Hue stream with no color driver).
        // For USB+Hue, Hue stream is now live so snapshot_hue_output_context()
        // returns a valid context and the worker can send to both outputs.
        const hueStartedOk = targetResults.hue?.ok === true;
        const needsLightingModeApply =
          runtimePlan.startTargets.includes("usb") ||
          (runtimePlan.startTargets.includes("hue") && hueStartedOk);

        if (needsLightingModeApply) {
          try {
            await setLightingMode(normalizedNextMode);
            if (runtimePlan.startTargets.includes("usb")) {
              targetResults.usb = { ok: true };
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (runtimePlan.startTargets.includes("usb")) {
              targetResults.usb = { ok: false, code: "USB_MODE_APPLY_FAILED", message: reason };
            }
          }
        }

        // Phase 3: Push initial solid color to Hue (solid mode only).
        // The backend set_lighting_mode already handles this via apply_hue_color_with_context,
        // but an explicit push here guarantees the bridge receives the latest UI color.
        if (
          hueStartedOk &&
          normalizedNextMode.kind === LIGHTING_MODE_KIND.SOLID &&
          normalizedNextMode.solid
        ) {
          try {
            await setHueSolidColor({
              r: normalizedNextMode.solid.r,
              g: normalizedNextMode.solid.g,
              b: normalizedNextMode.solid.b,
              brightness: normalizedNextMode.solid.brightness,
            });
          } catch { /* non-fatal: backend already applied the color */ }
        }

        const merged = applyRuntimeResultToTargets(runtimePlan, targetResults);
        setActiveOutputTargets(merged.activeTargets);
        if (merged.activeTargets.length > 0) {
          setLightingModeState(normalizedNextMode);
          scheduleLightingModePersist(normalizedNextMode);
        }
      } catch (error) {
        console.error(`[LumaSync] Failed to switch lighting mode to ${normalizedNextMode.kind}:`, error);
      } finally {
        modeTransitionLockRef.current = false;
        setIsModeTransitioning(false);

        const pendingModeChange = pendingModeChangeRef.current;
        pendingModeChangeRef.current = null;
        if (pendingModeChange) void handleLightingModeChange(pendingModeChange);
      }
    },
    [
      activeOutputTargets,
      handleOpenCalibration,
      hueStartConfig,
      lightingMode.ambilight,
      lightingMode.kind,
      lightingMode.solid,
      savedCalibration,
      scheduleLightingModePersist,
      selectedOutputTargets,
    ],
  );

  // Keep handleLightingModeChangeRef in sync so tray listeners always use latest handler
  handleLightingModeChangeRef.current = handleLightingModeChange;

  const modeGuard = canEnableLedMode(savedCalibration, selectedOutputTargets);

  return (
    <>
      <SettingsLayout
        activeSection={activeSection}
        onSectionChange={handleSectionChange}
        calibration={savedCalibration}
        calibrationStep={calibrationStep}
        lightingMode={lightingMode}
        outputTargets={selectedOutputTargets}
        usbConnected={isConnected}
        hueConfigured={hueStartConfig !== null}
        hueReachable={hueReachable || hueStreaming}
        hueStreaming={hueStreaming}
        modeLockReason={modeGuard.reason === MODE_GUARD_REASONS.CALIBRATION_REQUIRED ? modeGuard.reason : null}
        isModeTransitioning={isModeTransitioning}
        onLightingModeChange={handleLightingModeChange}
        onOutputTargetsChange={handleOutputTargetsChange}
        onCalibrationSaved={(config) => {
          setSavedCalibration(config);
        }}
        onCalibrationStepChange={setCalibrationStep}
        onCheckForUpdates={checkForUpdates}
        isCheckingForUpdates={updaterState.status === "checking"}
      />
      <UpdateModal
        state={updaterState}
        onInstall={downloadAndInstall}
        onDismiss={dismiss}
      />
      {showUsbSuggest && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 shadow-lg">
          <span className="text-sm text-zinc-200">{t("hotplug.usbDetected")}</span>
          <button
            type="button"
            onClick={() => { void handleAcceptUsbTarget(); }}
            className="rounded bg-zinc-600 px-3 py-1 text-xs text-white hover:bg-zinc-500"
          >
            {t("hotplug.addTarget")}
          </button>
          <button
            type="button"
            onClick={handleDismissUsbSuggest}
            className="text-xs text-zinc-400 hover:text-zinc-200"
          >
            {t("hotplug.dismiss")}
          </button>
        </div>
      )}
      {usbDisconnectNotice && (
        <div className="fixed bottom-4 right-4 z-50 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 shadow-lg">
          <span className="text-sm text-zinc-400">{t("hotplug.usbDisconnected")}</span>
        </div>
      )}
    </>
  );
}

export default App;
