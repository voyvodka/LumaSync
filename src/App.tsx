/**
 * App.tsx — Settings shell bootstrap
 *
 * Mounts the SettingsLayout, manages active section state,
 * and bridges shell persistence (window lifecycle + section restore).
 */

import { useState, useEffect, useCallback, useRef } from "react";
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
  const { state: updaterState, checkForUpdates, downloadAndInstall, dismiss } = useAutoUpdater();
  const [activeSection, setActiveSection] = useState<SectionId>(SECTION_IDS.CONTROL);
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
  const autoOpenTriggeredRef = useRef(sessionStorage.getItem("lumasync_calibration_opened") === "1");
  const modeTransitionLockRef = useRef(false);
  const pendingModeChangeRef = useRef<LightingModeConfig | null>(null);
  const persistLightingModeTimeoutRef = useRef<number | null>(null);
  const activeOutputTargetsRef = useRef<HueRuntimeTarget[]>([]);
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
    async function bootstrap() {
      try {
        const state = await loadShellState();
        // Map old section IDs to new ones for backward compatibility
        const sectionMap: Record<string, SectionId> = {
          general: SECTION_IDS.CONTROL,
          calibration: SECTION_IDS.CALIBRATION,
          "startup-tray": SECTION_IDS.SETTINGS,
          language: SECTION_IDS.SETTINGS,
          "about-logs": SECTION_IDS.SETTINGS,
          telemetry: SECTION_IDS.SETTINGS,
          device: SECTION_IDS.SETTINGS,
          control: SECTION_IDS.CONTROL,
          settings: SECTION_IDS.SETTINGS,
        };
        // On first launch keep the default CONTROL section.
        // On a page refresh (sessionStorage survives the reload) restore the last section.
        const isPageRefresh = sessionStorage.getItem("lumasync_session") === "1";
        sessionStorage.setItem("lumasync_session", "1");

        if (isPageRefresh) {
          const mappedSection = sectionMap[state.lastSection] ?? SECTION_IDS.CONTROL;
          setActiveSection(mappedSection);
        }
        setSavedCalibration(normalizeLedCalibrationConfig(state.ledCalibration));
        const restoredMode = normalizeLightingModeConfig(state.lightingMode);
        const restoredTargets = normalizeOutputTargets(state.lastOutputTargets);
        setLightingModeState(restoredMode);
        setSelectedOutputTargets(restoredTargets);
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
            if (
              isHueStartCodeOk(startResult.status.code) &&
              restoredMode.kind === LIGHTING_MODE_KIND.SOLID &&
              restoredMode.solid
            ) {
              await setHueSolidColor({
                r: restoredMode.solid.r,
                g: restoredMode.solid.g,
                b: restoredMode.solid.b,
                brightness: restoredMode.solid.brightness,
              });
            }
          } catch {}
        }

        await initWindowLifecycle({
          onFirstCloseToTray: () => {
            console.info(
              "[LumaSync] Hint: The app is still running in the system tray. " +
                "Click the tray icon to reopen settings.",
            );
          },
        });

        // Check for updates silently after startup
        void checkForUpdates();
      } catch (err) {
        console.warn("[LumaSync] Shell lifecycle bootstrap error:", err);
      }
    }

    bootstrap();
  }, []);

  const handleSectionChange = useCallback(async (sectionId: SectionId) => {
    setActiveSection(sectionId);
    try { await saveShellState({ lastSection: sectionId }); } catch {}
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
      setActiveSection(SECTION_IDS.CALIBRATION);
    }

    wasConnectedRef.current = isConnected;
  }, [isConnected, savedCalibration]);

  const handleOpenCalibration = useCallback(() => {
    const entry = startCalibrationFromSettings(savedCalibration);
    if (entry.open) {
      setCalibrationStep(entry.step);
      setActiveSection(SECTION_IDS.CALIBRATION);
    }
  }, [savedCalibration]);

  const handleOutputTargetsChange = useCallback(async (targets: HueRuntimeTarget[]) => {
    const normalizedTargets = normalizeOutputTargets(targets);
    setSelectedOutputTargets(normalizedTargets);
    try { await saveShellState({ lastOutputTargets: normalizedTargets }); } catch {}
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

      const requiresCalibration =
        !savedCalibration && normalizedNextMode.kind !== LIGHTING_MODE_KIND.OFF;

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
        for (const target of runtimePlan.startTargets) {
          if (target === "usb") {
            try {
              await setLightingMode(normalizedNextMode);
              targetResults.usb = { ok: true };
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              targetResults.usb = { ok: false, code: "USB_MODE_APPLY_FAILED", message: reason };
            }
          }

          if (target === "hue") {
            if (!runtimeHueStartConfig) {
              targetResults.hue = {
                ok: false,
                code: "CONFIG_NOT_READY_GATE_BLOCKED",
                message: "Hue start requires bridge, credential, and area configuration.",
              };
              continue;
            }

            try {
              const hueResult = await startHue(runtimeHueStartConfig);
              targetResults.hue = {
                ok: isHueStartCodeOk(hueResult.status.code),
                code: hueResult.status.code,
                message: hueResult.status.message,
              };

              if (
                targetResults.hue.ok &&
                normalizedNextMode.kind === LIGHTING_MODE_KIND.SOLID &&
                normalizedNextMode.solid
              ) {
                await setHueSolidColor({
                  r: normalizedNextMode.solid.r,
                  g: normalizedNextMode.solid.g,
                  b: normalizedNextMode.solid.b,
                  brightness: normalizedNextMode.solid.brightness,
                });
              }
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              targetResults.hue = { ok: false, code: "HUE_MODE_APPLY_FAILED", message: reason };
            }
          }
        }

        const merged = applyRuntimeResultToTargets(runtimePlan, targetResults);
        setActiveOutputTargets(merged.activeTargets);
        setLightingModeState(normalizedNextMode);
        scheduleLightingModePersist(normalizedNextMode);
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

  const modeGuard = canEnableLedMode(savedCalibration);

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
    </>
  );
}

export default App;
