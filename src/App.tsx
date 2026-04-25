/**
 * App.tsx — Settings shell bootstrap
 *
 * Mounts the SettingsLayout, manages active section state,
 * and bridges shell persistence (window lifecycle + section restore).
 */

// DEV PREVIEW — uncomment + comment out "export default App" below to preview
// import { HueAreaPreview } from "./dev/HueAreaPreview";
// export { HueAreaPreview as default };

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { SettingsLayout } from "./features/settings/SettingsLayout";
import { TitleBar, TITLE_BAR_HEIGHT_PX } from "./features/shell/TitleBar";
import { StatusBar, statusBarHeightPx, type StatusItem } from "./features/shell/StatusBar";
import { useAutoUpdater } from "./features/updater/useAutoUpdater";
import { UpdateModal } from "./features/updater/UpdateModal";
import {
  shouldAutoOpenCalibrationOnConnection,
  startCalibrationFromSettings,
} from "./features/calibration/state/entryFlow";
import { useDeviceConnection } from "./features/device/useDeviceConnection";
import {
  canEnableLedMode,
  MODE_GUARD_REASONS,
} from "./features/mode/state/modeGuard";
import {
  LIGHTING_MODE_KIND,
  normalizeLightingModeConfig,
  type AmbilightPayload,
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
import { HUE_RUNTIME_STATES, HUE_STATUS, type HueRuntimeTarget } from "./shared/contracts/hue";
import { DEFAULT_HUE_INTENSITY_PRESET, type HueIntensityPreset } from "./shared/contracts/hue";
import { DEVICE_COMMANDS, type ColorCorrectionConfig, type FirmwareProfile } from "./shared/contracts/device";
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

function App() {
  const { t } = useTranslation("common");
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
  // Capture display chosen by the user (v1.4 Platform GAP 2). Cached in a
  // ref so every set_lighting_mode call can inject it without awaiting
  // shellStore on the hot path. Hydrated on bootstrap and refreshed when
  // the calibration surface signals a change via onSaved.
  const selectedDisplayIdRef = useRef<string | undefined>(undefined);
  // Unified lighting smoothing preset (v1.4). Cached alongside the display
  // id for the same reason — every set_lighting_mode call stamps it into
  // `ambilight.lightingSmoothingPreset` without a synchronous shellStore
  // round-trip on the drag path. Named `hueIntensityPresetRef` historically;
  // kept under that name so the bootstrap + onChange wiring reads unchanged
  // while the payload field migrates to the unified name.
  const hueIntensityPresetRef = useRef<HueIntensityPreset>(DEFAULT_HUE_INTENSITY_PRESET);
  // Per-channel color correction (v1.4 G4). Cached so every set_lighting_mode
  // call can inject it without a synchronous shellStore round-trip. Hydrated on
  // bootstrap and updated when the settings panel signals a change.
  const colorCorrectionRef = useRef<ColorCorrectionConfig | undefined>(undefined);
  // Firmware encoding profile (v1.4 G11). Same caching rationale as
  // colorCorrectionRef — injected into every outgoing LightingModeConfig.
  const firmwareProfileRef = useRef<FirmwareProfile | undefined>(undefined);
  /**
   * hueSolidSyncedRef — "Bootstrap solid color sync" bayrağı.
   * Hue Running state'e her girişte bir kez lastSolidColor push edilir,
   * ardından true yapılır. Running dışına çıkınca false sıfırlanır.
   * Kullanıcı renk değiştirirken bu bayrak DOKUNULMAZ — loop'u önler.
   */
  const hueSolidSyncedRef = useRef(false);

  /**
   * Inject the persisted capture-source display id into an outgoing
   * LightingModeConfig payload (v1.4 Platform GAP 2). The ambilight
   * worker uses this id to bind its SCStream / windows-capture session
   * to the selected monitor; an absent or unknown id falls back to the
   * OS primary on the backend, so we only stamp the field when it is
   * actually set.
   */
  const withSelectedDisplayId = useCallback(
    (mode: LightingModeConfig): LightingModeConfig => {
      const id = selectedDisplayIdRef.current;
      if (!id || id.length === 0) return mode;
      return { ...mode, displayId: id };
    },
    [],
  );

  /**
   * Stamp the unified lighting smoothing preset onto the ambilight payload
   * of an outgoing LightingModeConfig (v1.4 unification). Only ambilight
   * runs use the preset — solid / off payloads pass through untouched. The
   * preset is a property of `AmbilightPayload` today so this helper mirrors
   * the shape the Rust `set_lighting_mode` handler expects; it drives both
   * the USB and the Hue EWMA coefficients on the worker.
   */
  const withAmbilightLightingSmoothingPreset = useCallback(
    (mode: LightingModeConfig): LightingModeConfig => {
      if (mode.kind !== LIGHTING_MODE_KIND.AMBILIGHT) return mode;
      const preset = hueIntensityPresetRef.current;
      const base: AmbilightPayload = mode.ambilight ?? { brightness: 1 };
      const nextAmbilight: AmbilightPayload = {
        ...base,
        lightingSmoothingPreset: preset,
      };
      return { ...mode, ambilight: nextAmbilight };
    },
    [],
  );

  /**
   * Stamp color correction and firmware profile onto any outgoing
   * LightingModeConfig. Both fields are top-level (not nested inside ambilight)
   * so they apply to all modes (ambilight, solid, off). Absent refs leave the
   * fields undefined — the Rust backend applies its own defaults via
   * #[serde(default)] so no runtime error occurs.
   */
  const withColorCorrectionAndFirmwareProfile = useCallback(
    (mode: LightingModeConfig): LightingModeConfig => ({
      ...mode,
      colorCorrection: colorCorrectionRef.current,
      firmwareProfile: firmwareProfileRef.current,
    }),
    [],
  );

  /**
   * Compose display id + Hue intensity preset + color correction + firmware profile
   * in a single helper so every call site stays short. Ordering is safe because
   * each helper stamps non-overlapping fields.
   */
  const hydrateModePayload = useCallback(
    (mode: LightingModeConfig): LightingModeConfig =>
      withColorCorrectionAndFirmwareProfile(
        withAmbilightLightingSmoothingPreset(withSelectedDisplayId(mode)),
      ),
    [withSelectedDisplayId, withAmbilightLightingSmoothingPreset, withColorCorrectionAndFirmwareProfile],
  );

  const lastPendingModeRef = useRef<LightingModeConfig | null>(null);

  const scheduleLightingModePersist = useCallback((mode: LightingModeConfig) => {
    lastPendingModeRef.current = mode;
    if (persistLightingModeTimeoutRef.current !== null) {
      window.clearTimeout(persistLightingModeTimeoutRef.current);
      persistLightingModeTimeoutRef.current = null;
    }
    persistLightingModeTimeoutRef.current = window.setTimeout(() => {
      persistLightingModeTimeoutRef.current = null;
      const pending = lastPendingModeRef.current;
      lastPendingModeRef.current = null;
      if (pending) void saveShellState({ lightingMode: pending });
    }, LIGHTING_MODE_PERSIST_DEBOUNCE_MS);
  }, []);

  // Flush pending lighting-mode persist on page hide / visibility change /
  // unmount so a Cmd+R or tray-close right after a slider move does not
  // discard the in-flight debounced write. Mirrors the pattern used for
  // window geometry persistence elsewhere in the shell.
  useEffect(() => {
    const flush = () => {
      if (persistLightingModeTimeoutRef.current !== null) {
        window.clearTimeout(persistLightingModeTimeoutRef.current);
        persistLightingModeTimeoutRef.current = null;
      }
      const pending = lastPendingModeRef.current;
      lastPendingModeRef.current = null;
      if (pending) void saveShellState({ lightingMode: pending });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flush();
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
    let timerId: number | null = null;

    const poll = async () => {
      if (!active) return;
      try {
        const result = await getHueStreamStatus();
        if (!active) return;

        const backendDead =
          result.status.state === HUE_RUNTIME_STATES.FAILED ||
          result.status.state === HUE_RUNTIME_STATES.IDLE;

        if (backendDead) {
          console.warn(
            `[LumaSync] Hue stream health check: backend reported ${result.status.state}. ` +
              `Message: ${result.status.message}. Removing "hue" from active targets.`,
          );
          setActiveOutputTargets((prev) => prev.filter((t) => t !== "hue"));
          return; // Dead stream detected, stop polling
        }
      } catch {
        // Network error polling status — do not remove target on transient fetch failure.
      }

      if (active) {
        timerId = window.setTimeout(() => {
          void poll();
        }, HUE_STREAM_HEALTH_POLL_MS);
      }
    };

    void poll();

    return () => {
      active = false;
      if (timerId !== null) window.clearTimeout(timerId);
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
        // Always start in compact — ignore any persisted uiMode.
        setCurrentMode("compact");
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
          "room-map": SECTION_IDS.ROOM_MAP,
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
        // Hydrate capture-source ref so the bootstrap set_lighting_mode
        // call (below) honours the user's persisted display selection.
        selectedDisplayIdRef.current =
          typeof state.selectedDisplayId === "string" && state.selectedDisplayId.length > 0
            ? state.selectedDisplayId
            : undefined;
        // Hydrate Hue intensity preset ref. Absent ⇒ DEFAULT_HUE_INTENSITY_PRESET
        // so the ambilight worker always receives a deterministic preset.
        hueIntensityPresetRef.current =
          state.lightingIntensityPreset ?? DEFAULT_HUE_INTENSITY_PRESET;
        // Hydrate color correction and firmware profile refs (v1.4 G4 / G11).
        // Absent in persisted state ⇒ refs stay undefined; backend defaults apply.
        colorCorrectionRef.current = state.colorCorrection;
        firmwareProfileRef.current = state.firmwareProfile;
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
                await setLightingMode(hydrateModePayload({
                  ...restoredMode,
                  targets: bootTargets,
                }));
              }
            }
          } catch (err) {
            console.error("[LumaSync] Bootstrap mode/targets restore failed:", err);
          }
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
    try {
      await saveShellState({ lastSection: sectionId });
    } catch (err) {
      console.error("[LumaSync] saveShellState(lastSection) failed:", err);
    }
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
      setActiveSection(SECTION_IDS.LED_SETUP);
    }

    wasConnectedRef.current = isConnected;
  }, [isConnected, savedCalibration]);

  const handleOpenCalibration = useCallback(() => {
    const entry = startCalibrationFromSettings(savedCalibration);
    if (entry.open) {
      setActiveSection(SECTION_IDS.LED_SETUP);
    }
  }, [savedCalibration]);

  const handleOutputTargetsChange = useCallback(async (targets: HueRuntimeTarget[]) => {
    const normalizedTargets = normalizeOutputTargets(targets);
    const prevTargets = selectedOutputTargets;
    setSelectedOutputTargets(normalizedTargets);
    try {
      await saveShellState({ lastOutputTargets: normalizedTargets });
    } catch (err) {
      console.error("[LumaSync] saveShellState(lastOutputTargets) failed:", err);
    }

    // Delta logic — only when a mode is actively running (not OFF)
    if (lightingMode.kind === LIGHTING_MODE_KIND.OFF) return;

    const currentActive = activeOutputTargetsRef.current;
    const addedTargets = normalizedTargets.filter((t) => !prevTargets.includes(t));
    const removedTargets = prevTargets.filter((t) => !normalizedTargets.includes(t));

    // Delta-stop: for each removed target that is currently active, stop it
    for (const target of removedTargets) {
      if (!currentActive.includes(target)) continue;
      if (target === "usb") {
        try {
          await invoke("stop_lighting");
        } catch (err) {
          console.error("[LumaSync] stop_lighting during delta-stop failed:", err);
        }
      }
      if (target === "hue") {
        try {
          await invoke("stop_hue_stream");
        } catch (err) {
          console.error("[LumaSync] stop_hue_stream during delta-stop failed:", err);
        }
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
          await setLightingMode(hydrateModePayload({
            kind: lightingMode.kind,
            solid: lightingMode.solid,
            ambilight: lightingMode.ambilight,
            targets: normalizedTargets,
          }));
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
              await setLightingMode(hydrateModePayload({
                kind: lightingMode.kind,
                solid: lightingMode.solid,
                ambilight: lightingMode.ambilight,
                targets: normalizedTargets,
              }));
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
              } catch (err) {
                console.error("[LumaSync] Hue solid push on delta-start non-fatal failure:", err);
              }
            }
          }
        } catch {
          // D-06: silently skip failed target, existing targets continue
          console.warn("[seamless-switch] Hue delta-start failed, skipping");
        }
      }
    }
  }, [lightingMode, selectedOutputTargets, hueStartConfig, hydrateModePayload]);

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
      // Quick adjustment: same mode kind → pure config nudge (color/brightness).
      // We intentionally DO NOT require `isSameTargetSet(selected, active)` here.
      // If selected != active we still take the quick path and push the update
      // to whatever IS currently active; falling through to the full transition
      // path just to "reconcile" targets would flip `isModeTransitioning = true`,
      // which disables the brightness slider mid-drag and makes the browser
      // release pointer capture — symptom: drag breaks after a single commit.
      const isQuickSolidAdjustment =
        normalizedNextMode.kind === LIGHTING_MODE_KIND.SOLID &&
        lightingMode.kind === LIGHTING_MODE_KIND.SOLID;

      if (isQuickSolidAdjustment && normalizedNextMode.solid) {
        setLightingModeState(normalizedNextMode);
        scheduleLightingModePersist(normalizedNextMode);

        if (activeOutputTargets.includes("usb")) {
          void setLightingMode(hydrateModePayload(normalizedNextMode)).catch((error) => {
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

      // Fast path: ambilight already running and only settings changed (brightness,
      // smoothing, black border) — send live update without the full transition flow.
      // The Rust backend detects this case and updates live atomics in-place
      // (AMBILIGHT_MODE_UPDATED) without touching the worker or SCStream.
      // Same reasoning as isQuickSolidAdjustment — see note above. An ambilight
      // brightness nudge during a drag must never promote to the full transition
      // path just because target reconciliation is pending.
      const isQuickAmbilightAdjustment =
        normalizedNextMode.kind === LIGHTING_MODE_KIND.AMBILIGHT &&
        lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT;

      if (isQuickAmbilightAdjustment) {
        setLightingModeState(normalizedNextMode);
        scheduleLightingModePersist(normalizedNextMode);
        void setLightingMode(hydrateModePayload(normalizedNextMode)).catch((error) => {
          console.error("[LumaSync] Failed to push Ambilight settings update:", error);
        });
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
          // Optimization: Execute stop commands concurrently for independent targets
          // (USB and Hue) to minimize shutdown phase and mode transition latency.
          await Promise.all(
            runtimePlan.stopTargets.map(async (target) => {
              if (target === "usb") {
                await stopLighting();
                targetResults.usb = { ok: true };
              }
              if (target === "hue") {
                const hueResult = await stopHue();
                targetResults.hue = {
                  ok: isHueStopCodeOk(hueResult.status.code),
                  code: hueResult.status.code,
                  message: hueResult.status.message,
                };
              }
            })
          );

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
        // For Ambilight mode with a transient Hue failure (e.g. bridge has a stale
        // session — CONFIG_NOT_READY_GATE_BLOCKED): still start the backend worker.
        // The worker runs without Hue context initially; the stream auto-reconnects
        // in ~30s and the user can re-select Ambilight to pick up colors.
        const hueTransientFail =
          !hueStartedOk &&
          normalizedNextMode.kind === LIGHTING_MODE_KIND.AMBILIGHT &&
          runtimePlan.startTargets.includes("hue");
        const needsLightingModeApply =
          runtimePlan.startTargets.includes("usb") ||
          (runtimePlan.startTargets.includes("hue") && hueStartedOk) ||
          hueTransientFail;

        if (needsLightingModeApply) {
          try {
            await setLightingMode(hydrateModePayload(normalizedNextMode));
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
          } catch (err) {
            console.error("[LumaSync] Hue solid push after mode change non-fatal failure:", err);
          }
        }

        const merged = applyRuntimeResultToTargets(runtimePlan, targetResults);
        setActiveOutputTargets(merged.activeTargets);
        // Only reflect user intent in the UI when at least one backend command was
        // issued. If all targets were gate-blocked (e.g. Hue config missing), the
        // mode stays unchanged so the UI matches actual backend state.
        if (needsLightingModeApply) {
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
      hydrateModePayload,
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
    onLightingModeChange: handleLightingModeChange,
    onOutputTargetsChange: handleOutputTargetsChange,
    onCalibrationSaved: (config: LedCalibrationConfig) => {
      setSavedCalibration(config);
    },
    onCheckForUpdates: checkForUpdates,
    isCheckingForUpdates: updaterState.status === "checking",
    devSetUpdaterState,
    onHueIntensityPresetChange: (preset: HueIntensityPreset) => {
      hueIntensityPresetRef.current = preset;
      // Hot-reload an in-flight ambilight worker so the new preset takes
      // effect without a mode switch. For non-ambilight modes the preset
      // simply rides along on the next start_lighting_mode dispatch.
      if (lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT) {
        void setLightingMode(hydrateModePayload(lightingMode)).catch((error) => {
          console.error("[LumaSync] Failed to hot-reload Hue intensity preset:", error);
        });
      }
    },
    onColorCorrectionChange: (next: ColorCorrectionConfig) => {
      // ColorCorrectionPanel already persisted via shellStore.save() on
      // commit; we mirror the new config into the ref so the very next
      // outgoing set_lighting_mode payload carries it, then hot-reload
      // any in-flight worker so USB + Hue sinks pick up the new pipeline
      // without a mode toggle. Solid / off modes also benefit because
      // the Rust encoder path runs color correction before every sink.
      colorCorrectionRef.current = next;
      void setLightingMode(hydrateModePayload(lightingMode)).catch((error) => {
        console.error("[LumaSync] Failed to hot-reload color correction:", error);
      });
    },
    onFirmwareProfileChange: (next: FirmwareProfile) => {
      // FirmwareProfilePicker already persisted via shellStore.save() on
      // commit; mirror into the ref + trigger a worker restart with the
      // new protocol. Changing firmware profile is a wire-format change
      // on the Rust side so a silent flicker is expected — the USB
      // encoder pipeline rebuilds before the next frame.
      firmwareProfileRef.current = next;
      void setLightingMode(hydrateModePayload(lightingMode)).catch((error) => {
        console.error("[LumaSync] Failed to hot-reload firmware profile:", error);
      });
    },
    // v1.5 W2-B1 — compact-mode "no reachable output" banner deep-link.
    // The full-mode shell already exposes DEVICES through the sidebar, so
    // this prop is consumed exclusively by `<CompactLayout>`.
    onOpenDevices: () => void handleSectionChange(SECTION_IDS.DEVICES),
  } as const;

  // Derive runtime status items for the bottom StatusBar. Order matches the
  // mockup (CAP / USB / HUE). CAP is "ok" only while ambilight is the active
  // mode — that's the only mode that actually consumes screen frames.
  // v1.5 W2-B1 — Reconnect deep-link to the DEVICES section. Both USB and
  // Hue chips offer the affordance whenever they are not in a healthy state:
  // the icon button rendered inside the StatusBar pill takes the user to
  // the place they can actually fix the issue (re-pair, replug, retry).
  const openDevicesSection = () => void handleSectionChange(SECTION_IDS.DEVICES);

  const statusItems: StatusItem[] = [
    {
      label: "CAP",
      state: lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT ? "OK" : "—",
      kind: lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT ? "ok" : "idle",
    },
    {
      label: "USB",
      state: isConnected ? "OK" : "OFF",
      kind: isConnected ? "ok" : "off",
      onReconnect: isConnected ? undefined : openDevicesSection,
      reconnectAriaLabel: t("statusBar.reconnect.usbAriaLabel"),
    },
    {
      label: "HUE",
      state: hueStreaming
        ? "STREAMING"
        : hueReachable
          ? "OK"
          : hueStartConfig
            ? "IDLE"
            : "OFF",
      kind: hueStreaming
        ? "active"
        : hueReachable
          ? "ok"
          : hueStartConfig
            ? "idle"
            : "off",
      onReconnect:
        hueStreaming || hueReachable ? undefined : openDevicesSection,
      reconnectAriaLabel: t("statusBar.reconnect.hueAriaLabel"),
    },
  ];
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
          <SettingsLayout uiMode={currentMode} {...sharedSettingsLayoutProps} />
        </div>
      </div>
      <StatusBar items={statusItems} uiMode={currentMode} />
      <UpdateModal
        state={updaterState}
        onInstall={downloadAndInstall}
        onDismiss={dismiss}
        onRetry={() => void checkForUpdates()}
      />
      {showUsbSuggest && (
        <div
          className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg px-4 py-3 shadow-lg"
          style={{ background: "var(--lm-panel-2)", border: "1px solid var(--lm-line-2)", color: "var(--lm-ink)" }}
        >
          <span style={{ fontSize: "12px" }}>{t("hotplug.usbDetected")}</span>
          <button
            type="button"
            onClick={() => { void handleAcceptUsbTarget(); }}
            style={{ fontSize: "11px", padding: "2px 10px", borderRadius: "4px", background: "var(--lm-amber)", color: "#07080a", fontWeight: 600, border: "none", cursor: "pointer" }}
          >
            {t("hotplug.addTarget")}
          </button>
          <button
            type="button"
            onClick={handleDismissUsbSuggest}
            style={{ fontSize: "11px", color: "var(--lm-muted)", background: "transparent", border: "none", cursor: "pointer" }}
          >
            {t("hotplug.dismiss")}
          </button>
        </div>
      )}
      {usbDisconnectNotice && (
        <div
          className="fixed bottom-4 right-4 z-50 rounded-lg px-4 py-3 shadow-lg"
          style={{ background: "var(--lm-panel-2)", border: "1px solid var(--lm-line-2)", color: "var(--lm-ink)" }}
        >
          <span style={{ fontSize: "12px", color: "var(--lm-muted)" }}>{t("hotplug.usbDisconnected")}</span>
        </div>
      )}
    </>
  );
}

export default App;
