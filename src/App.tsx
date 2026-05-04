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
import { OnboardingFlow } from "./features/onboarding/ui/OnboardingFlow";
import { useAutoUpdater } from "./features/updater/useAutoUpdater";
import { UpdateModal } from "./features/updater/UpdateModal";
import {
  shouldAutoOpenCalibrationOnConnection,
  startCalibrationFromSettings,
} from "./features/calibration/state/entryFlow";
import { useDeviceConnection } from "./features/device/useDeviceConnection";
import { connectionEvents } from "./features/device/connectionEvents";
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
/**
 * Hard floor on the rate at which non-`force` `setLightingMode` invokes are
 * allowed to reach the Tauri backend. Belt-and-braces backstop for the
 * content-based dedup signature: even if a re-render storm somehow produces
 * payloads whose canonical hash differs, the cooldown swallows everything
 * within 20 ms of the previous dispatch. This caps the FE→Rust hot path at
 * 50 Hz, which is well above any legitimate quick-adjustment source — the
 * HsvColorPicker drag throttle commits at 50 ms (20 Hz) and CompactLayout's
 * brightness slider at 50 ms (20 Hz), so legit user actions never get
 * dropped by this floor.
 */
const SET_LIGHTING_MODE_MIN_INTERVAL_MS = 20;

/**
 * Stable, key-sorted JSON serialisation of a `LightingModeConfig`. The
 * earlier `JSON.stringify(hydrated)` signature was *content* equal across
 * identical re-fires but *string* unequal whenever the spread chain in
 * `hydrateModePayload` produced a different key insertion order — typical
 * for hot-reload paths that re-stamp `colorCorrection` / `firmwareProfile`
 * after the ambilight worker is already live. Two payloads with the same
 * semantic content but a different key order therefore slipped past the
 * idempotent dedup, reached the Rust handler, and any field whose Rust-side
 * `==` check failed (targets, displayId, led_calibration, color_correction,
 * firmware_profile — see `apply_mode_change` fast-path gate) caused a full
 * worker tear-down + restart instead of an in-place atomic update.
 *
 * Replacing the signature with a canonical, recursively key-sorted form
 * makes the dedup ref behave like deep-equality without paying for a deep
 * compare on every dispatch.
 */
function canonicalLightingModeSignature(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        const v = (val as Record<string, unknown>)[k];
        if (v !== undefined) sorted[k] = v;
      }
      return sorted;
    }
    return val;
  });
}

interface HueStartConfig {
  bridgeIp: string;
  username: string;
  clientKey: string;
  areaId: string;
}

function normalizeOutputTargets(value: unknown): HueRuntimeTarget[] {
  // First-install case (`undefined` / non-array shape from the persisted
  // store): fall back to DEFAULT_OUTPUT_TARGETS so a fresh user lands on a
  // sensible primary output. An EXPLICIT empty array means the user (or the
  // unsupported-USB auto-fallback) has cleared targets — respect that and
  // return `[]`. The previous unconditional DEFAULT fallback re-added the
  // very target we had just removed and stranded the auto-deselect path.
  if (!Array.isArray(value)) return [...DEFAULT_OUTPUT_TARGETS];
  const targetSet = new Set(
    value.filter((t): t is HueRuntimeTarget => t === "usb" || t === "hue"),
  );
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
  // Mirror of `hueStartConfig` so the connection-event subscriber (in a
  // useEffect with `[]` deps) can read the latest paired-bridge state
  // without re-subscribing on every state mutation.
  const hueStartConfigRef = useRef<HueStartConfig | null>(null);
  const [hueReachable, setHueReachable] = useState(false);
  const [isModeTransitioning, setIsModeTransitioning] = useState(false);
  const { isConnected } = useDeviceConnection();
  const wasConnectedRef = useRef(false);
  // Hot-plug detection refs/state — separate from wasConnectedRef (per Pitfall 4)
  const prevUsbConnectedRef = useRef<boolean | null>(null); // null = not yet initialized
  const [bootstrapDone, setBootstrapDone] = useState(false);
  const [showUsbSuggest, setShowUsbSuggest] = useState(false);
  const [usbDisconnectNotice, setUsbDisconnectNotice] = useState(false);
  // Bug 10D — surfaces a one-time non-blocking notice when boot-time
  // auto-reconnect rejects with PORT_UNSUPPORTED / PORT_NOT_FOUND, so
  // the user understands why we just dropped them into Hue-only mode.
  // Distinct from `usbDisconnectNotice` (which fires on a runtime
  // unplug) so the copy can be specific.
  const [usbUnsupportedNotice, setUsbUnsupportedNotice] = useState(false);
  // A1.2 — surfaces the targets whose stop_lighting / stop_hue_stream invoke
  // failed during a delta-stop, so the chip stays active instead of silently
  // lying about state. Banner auto-dismisses; user can retry by toggling.
  const [stopFailedNotice, setStopFailedNotice] = useState<HueRuntimeTarget[] | null>(null);

  // v1.5 W2-B4 — first-run onboarding state. The flag is hydrated from
  // shellStore on bootstrap; a fresh user (`undefined` / `false`) sees
  // the inline 3-step banner. \`hasInteractedWithMode\` flips true on
  // the first deliberate mode click after bootstrap so step 1 only
  // advances when the user actively engages.
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState<boolean>(true);
  const [hasInteractedWithMode, setHasInteractedWithMode] = useState(false);
  const autoOpenTriggeredRef = useRef(sessionStorage.getItem("lumasync_calibration_opened") === "1");
  const modeTransitionLockRef = useRef(false);
  const bootstrapRanRef = useRef(false);
  const pendingModeChangeRef = useRef<LightingModeConfig | null>(null);
  /**
   * Idempotent dispatch guard for `setLightingMode` (v1.5 fix #45).
   * Quick-adjustment paths (Solid drag, Ambilight knob nudge) and the
   * hot-reload effects (color correction / firmware profile / lighting
   * smoothing preset) all funnel through `setLightingMode`. A stuck
   * subscriber or a re-render storm can land the same payload many
   * times in a row; we hash each outgoing payload and skip the invoke
   * when the signature matches the last one we already sent. The Rust
   * backend is itself idempotent, but skipping the round-trip keeps
   * the IPC channel quiet and the worker fast-path uncluttered. Reset
   * to null on every confirmed mode transition so the next dispatch
   * after a real mode change always reaches the backend.
   */
  const lastSentPayloadSignatureRef = useRef<string | null>(null);
  /**
   * Wall-clock timestamp (ms) of the last `setLightingMode` invoke that
   * actually reached the Tauri backend. Pairs with the signature ref to
   * enforce `SET_LIGHTING_MODE_MIN_INTERVAL_MS` as a temporal floor on
   * non-`force` dispatches. See `dispatchSetLightingMode` for the full
   * rationale.
   */
  const lastSetLightingModeAtRef = useRef<number>(0);
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
  // Persisted LED calibration (v1.4 USB per-LED sampling anchor). Same
  // caching rationale as colorCorrectionRef — every outgoing
  // set_lighting_mode payload stamps it onto `ledCalibration` so the
  // Rust ambilight worker and the Solid encoder both size their USB
  // packets correctly. Without this stamp the backend's `total_leds`
  // falls back to 1 and only LED #0 reflects screen content.
  const savedCalibrationRef = useRef<LedCalibrationConfig | undefined>(undefined);
  /**
   * Persisted ambilight settings (v1.5 H1 fix — bug H1).
   *
   * The bootstrap pipeline already dispatches the correctly-restored
   * `restoredMode.ambilight` payload, but the very next render cycle
   * fires hot-reload effects (color correction / firmware profile /
   * Hue intensity preset) and the USB hot-plug delta-start branch
   * which all read `lightingMode` *from React state via closure*. At
   * that moment `setLightingModeState(restoredMode)` may not have
   * flushed yet, so the closure captures `{ kind: OFF }` (or a
   * fresh-default ambilight payload) and re-dispatches a stripped
   * payload — wiping the user's saturation / blackBorderDetection /
   * smoothing-preset values until the next manual mode toggle.
   *
   * Mirroring the persisted ambilight payload into a ref lets the
   * `withAmbilightSettings` hydrator stamp those values onto every
   * outgoing dispatch the moment the user-intent kind is Ambilight,
   * regardless of which closure produced the payload. Caller-wins for
   * non-default explicit values so slider commits never get clobbered.
   */
  const savedAmbilightRef = useRef<AmbilightPayload | undefined>(undefined);
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
   * Stamp the persisted ambilight settings onto an outgoing
   * LightingModeConfig payload (v1.5 H1 fix — bug H1).
   *
   * The bootstrap path dispatches the correctly-restored payload, but
   * subsequent same-tick effects (color-correction / firmware-profile
   * / Hue-intensity hot-reload, USB hot-plug delta-start) read
   * `lightingMode` from a stale React closure. Without a ref-backed
   * hydrator those re-dispatches strip the user's persisted
   * saturation / blackBorderDetection / smoothing-preset values.
   *
   * Behaviour:
   *  - Only fires when `mode.kind === AMBILIGHT` (off / solid pass
   *    through untouched — those modes don't carry ambilight).
   *  - Caller-wins: if the caller already supplied an explicit
   *    non-default ambilight payload (e.g. an in-flight slider commit
   *    from `LightsSection`), we keep it.
   *  - Stamps from `savedAmbilightRef.current` only when the caller
   *    payload is undefined or matches the fresh-default shape
   *    (saturation 1.0, blackBorderDetection false, smoothing absent).
   *  - Brightness is treated as a real value: a freshly-defaulted
   *    `{ brightness: 1 }` payload is still considered "fresh"
   *    because every other knob is at default.
   */
  const withAmbilightSettings = useCallback(
    (mode: LightingModeConfig): LightingModeConfig => {
      if (mode.kind !== LIGHTING_MODE_KIND.AMBILIGHT) return mode;
      const persisted = savedAmbilightRef.current;
      if (!persisted) return mode;
      const incoming = mode.ambilight;
      // Caller-wins: anything that looks like an explicit user
      // commit (non-default saturation / blackBorderDetection /
      // smoothing preset) is kept. We only stamp when the caller's
      // payload is absent or carries a fresh-default shape.
      const isFreshDefault =
        !incoming ||
        ((incoming.saturation === undefined || incoming.saturation === 1) &&
          (incoming.blackBorderDetection === undefined ||
            incoming.blackBorderDetection === false) &&
          incoming.lightingSmoothingPreset === undefined &&
          (incoming.smoothingAlpha === undefined || incoming.smoothingAlpha === 0.35));
      if (!isFreshDefault) return mode;
      // Stamp persisted values, but preserve any explicit brightness
      // the caller supplied — brightness is a top-level slider that
      // can legitimately be 1.0 in the persisted state too.
      const merged: AmbilightPayload = {
        ...persisted,
        brightness:
          incoming?.brightness !== undefined ? incoming.brightness : persisted.brightness,
      };
      return { ...mode, ambilight: merged };
    },
    [],
  );

  /**
   * Stamp the persisted LED calibration onto an outgoing
   * LightingModeConfig payload. The Rust backend uses
   * `ledCalibration.totalLeds` to size every emitted USB frame for both
   * Solid and Ambilight modes; without this stamp the backend falls
   * back to a 1-LED slice and only LED #0 reflects strip output.
   *
   * Behaviour:
   *  - If the caller already provided `ledCalibration` on the incoming
   *    mode, we keep that explicit value (caller-wins so test patterns
   *    or future overrides are not clobbered).
   *  - Otherwise we stamp `savedCalibrationRef.current` if present.
   *  - When the user has never run calibration the ref is `undefined`,
   *    so the field stays absent and the backend keeps its existing
   *    legacy 1-LED fallback (no regression).
   */
  const withLedCalibration = useCallback(
    (mode: LightingModeConfig): LightingModeConfig => {
      if (mode.ledCalibration) return mode;
      const calibration = savedCalibrationRef.current;
      if (!calibration) return mode;
      return { ...mode, ledCalibration: calibration };
    },
    [],
  );

  /**
   * Compose display id + Hue intensity preset + color correction + firmware profile
   * + LED calibration in a single helper so every call site stays short. Ordering
   * is safe because each helper stamps non-overlapping fields.
   */
  const hydrateModePayload = useCallback(
    (mode: LightingModeConfig): LightingModeConfig =>
      withColorCorrectionAndFirmwareProfile(
        withAmbilightLightingSmoothingPreset(
          withLedCalibration(withAmbilightSettings(withSelectedDisplayId(mode))),
        ),
      ),
    [
      withSelectedDisplayId,
      withAmbilightSettings,
      withLedCalibration,
      withAmbilightLightingSmoothingPreset,
      withColorCorrectionAndFirmwareProfile,
    ],
  );

  const lastPendingModeRef = useRef<LightingModeConfig | null>(null);

  /**
   * Idempotent funnel for every `setLightingMode` Tauri invoke (v1.5
   * fix #45 + Ambilight-spam follow-up).
   *
   * Every direct call site — quick adjustments, hot-reload effects
   * (color correction / firmware profile / lighting smoothing preset),
   * delta-start re-applies in `handleOutputTargetsChange`, slow-path
   * mode transitions — funnels through this helper so a stuck
   * subscriber, re-render storm, or React-19-StrictMode double-fire can
   * never spam the IPC bus with identical payloads. The Rust backend is
   * itself idempotent for matching kinds, but skipping the round-trip
   * keeps the worker fast-path uncluttered and the dev terminal
   * readable.
   *
   * `force: true` is reserved for paths where the backend may need a
   * forced re-apply even when the FE signature matches — e.g. the
   * delta-start re-apply after `startHue` succeeds (worker has to pick
   * up the now-live Hue context) and the slow-path mode-kind
   * transition (the prior signature is stale by definition). Force
   * always **updates** the ref so a subsequent identical fire from a
   * hot-reload effect is still skipped.
   */
  const dispatchSetLightingMode = useCallback(
    async (
      mode: LightingModeConfig,
      opts: { force?: boolean } = {},
    ): Promise<void> => {
      const hydrated = hydrateModePayload(mode);
      // Content-based signature: order-independent key sort eliminates the
      // false-negative dedup that happened when `hydrateModePayload`'s
      // spread chain produced a different key insertion order across
      // back-to-back identical fires (Ambilight-mode spam regression — the
      // hot-reload paths in particular re-stamp `colorCorrection` /
      // `firmwareProfile` last, which moves them to the end of the object
      // every other call). See `canonicalLightingModeSignature` for the
      // full rationale.
      const signature = canonicalLightingModeSignature(hydrated);
      if (!opts.force) {
        // Layer 1 — content dedup. Identical semantic payload? Skip.
        if (lastSentPayloadSignatureRef.current === signature) {
          return;
        }
        // Layer 2 — temporal cooldown. Belt-and-braces for any unknown
        // 50–60 Hz spam source we have not traced yet (re-render storm,
        // stuck subscriber, future regression). The Rust handler is
        // idempotent for ambilight settings updates but takes the full
        // worker tear-down + restart path whenever any of its own
        // equality gates fail (targets / displayId / led_calibration /
        // color_correction / firmware_profile), so even a few stray
        // mismatches per second visibly stutter the strip. Capping the
        // dispatch rate at 50 Hz protects the worker without slowing
        // legitimate quick adjustments — drag commits across the app are
        // already throttled to 20 Hz upstream.
        const now = Date.now();
        if (now - lastSetLightingModeAtRef.current < SET_LIGHTING_MODE_MIN_INTERVAL_MS) {
          return;
        }
        lastSetLightingModeAtRef.current = now;
      } else {
        // `force` path still updates the cooldown clock so a follow-up
        // non-force fire 1 ms later is correctly cooled. Without this the
        // very next quick adjustment after a slow-path transition could
        // sneak through during the cooldown window.
        lastSetLightingModeAtRef.current = Date.now();
      }
      lastSentPayloadSignatureRef.current = signature;
      await setLightingMode(hydrated);
    },
    [hydrateModePayload],
  );

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
  //
  // Visibility-aware (recursive setTimeout, not setInterval): the tray
  // window can be hidden indefinitely with the React tree mounted, so
  // unconditional 30 s ticks would keep firing HTTPS Bridge requests
  // nobody can see. The loop pauses while hidden and resumes with an
  // immediate first tick on `visibilitychange` so the chip refreshes
  // instantly when the user re-opens the window.
  // ---------------------------------------------------------------------------
  const hueStreaming = activeOutputTargets.includes("hue");
  useEffect(() => {
    if (!hueStartConfig || hueStreaming) return;

    let mounted = true;
    let timeoutId: number | null = null;
    let inFlight = false;

    const tick = async () => {
      if (!mounted) return;
      if (inFlight) return;
      if (document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const validation = await validateHueCredentials(
          hueStartConfig.bridgeIp,
          hueStartConfig.username,
          hueStartConfig.clientKey,
        );
        if (!mounted) return;
        setHueReachable(validation.status.code === HUE_STATUS.CREDENTIAL_VALID);
      } catch {
        if (mounted) setHueReachable(false);
      } finally {
        inFlight = false;
        scheduleNext();
      }
    };

    const scheduleNext = () => {
      if (!mounted) return;
      if (document.visibilityState === "hidden") return;
      if (timeoutId !== null) return;
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        void tick();
      }, HUE_BRIDGE_REACHABILITY_POLL_MS);
    };

    const handleVisibilityChange = () => {
      if (!mounted) return;
      if (document.visibilityState === "visible" && timeoutId === null && !inFlight) {
        void tick();
      }
    };

    void tick();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      mounted = false;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
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
          // Guard: only adopt the bridge's lastSolidColor when the UI is
          // (still) in SOLID mode. Without this check, a persisted Ambilight
          // session bootstrapping with hue_targets included would have the
          // UI silently flipped to Solid the moment the stream came up —
          // surfacing as bug #43 (LEDs animate, UI shows Solid) and
          // racing the active ambilight worker (bug #44).
          if (snap && lightingModeRef.current.kind === LIGHTING_MODE_KIND.SOLID) {
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
        const hydratedCalibration = normalizeLedCalibrationConfig(state.ledCalibration);
        setSavedCalibration(hydratedCalibration);
        // Prime the ref synchronously so the bootstrap set_lighting_mode
        // fired below already carries the calibration — the
        // useEffect that mirrors state->ref has not flushed yet.
        savedCalibrationRef.current = hydratedCalibration;
        // v1.5 W2-B4 — fresh installs land on \`undefined\`; treat that as
        // "never completed" so the onboarding banner mounts. Existing
        // v1.4 users upgrading without the flag also see it once and
        // can dismiss with one click — no destructive migration.
        setHasCompletedOnboarding(state.hasCompletedOnboarding === true);
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
        // v1.5 H1 — prime savedAmbilightRef synchronously so any same-tick
        // dispatch fired before `setLightingModeState(restoredMode)` flushes
        // (color-correction / firmware-profile / Hue-intensity hot-reload,
        // USB hot-plug delta-start) still carries the persisted saturation /
        // blackBorderDetection / smoothing-preset values. The mirror effect
        // below keeps the ref in sync with subsequent state updates.
        savedAmbilightRef.current = restoredMode.ambilight;
        setLightingModeState(restoredMode);

        // v1.5 H3 — read live USB connection state but DO NOT strip "usb"
        // from selectedOutputTargets when the snapshot returns
        // `connected: false`. Cold launch races against
        // `tryAutoReconnect`'s 2 s BOOTLOADER_SETTLE_DELAY_MS: ~20-30%
        // of starts the bootstrap finishes first, sees `connected: false`,
        // and silently drops the user's persisted USB target. Auto-reconnect
        // then completes and emits `connected: true` — but "usb" was already
        // gone from targets state, so the membership check at the hot-plug
        // effect (App.tsx ~L1094) is a noop. End result: the Lights output
        // is silently disabled until the user toggles it manually.
        //
        // Fix (Opsiyon A): keep "usb" in `selectedOutputTargets` regardless
        // of the bootstrap snapshot. `modeGuard` already shows visual
        // disabled state when `isConnected === false`, so user clarity is
        // preserved. The hot-plug effect handles the connect-arrival side:
        // its `includes("usb")` membership check passes once auto-reconnect
        // emits, and the LED setup section / status pill flips to OK.
        //
        // `prevUsbConnectedRef.current = bootstrapUsbAvailable` stays
        // unchanged — it tracks "was USB physically connected last time
        // we checked", not "is it in selectedTargets". Without it the
        // false→true transition would refire on every cold start.
        //
        // Follow-up note: `useDeviceConnection`'s controller `useMemo`
        // (useDeviceConnection.ts:858-923) still rebuilds when
        // `initialLastSuccessfulPort` settles late — that's a wall-time
        // artifact, not a correctness bug, and is out of scope for H3.
        let bootstrapUsbAvailable = false;
        try {
          const connectionStatus = await invoke<{ connected: boolean }>(
            DEVICE_COMMANDS.GET_CONNECTION_STATUS,
          );
          bootstrapUsbAvailable = connectionStatus.connected;
        } catch {
          // Status check failed — leave bootstrapUsbAvailable=false; we
          // still keep restoredTargets as-is below.
        }
        // Always honour the persisted target set; do NOT strip "usb"
        // when the bootstrap snapshot reports it offline.
        setSelectedOutputTargets(restoredTargets);

        // Initialize hot-plug ref AFTER USB status is known
        // This prevents false "USB detected" events on startup
        prevUsbConnectedRef.current = bootstrapUsbAvailable;

        const isActive = restoredMode.kind !== LIGHTING_MODE_KIND.OFF;
        setActiveOutputTargets(isActive ? restoredTargets : []);
        // v1.5 W2-B4 — prime the LIGHTS-step guard from disk. Any persisted
        // lightingMode (even \`off\`) means the user picked a mode at some
        // point, so the onboarding flow should not gate them at step 1
        // waiting for a fresh click. Truly fresh installs land here with
        // \`state.lightingMode === undefined\` and the guard stays false.
        if (state.lightingMode !== undefined) {
          setHasInteractedWithMode(true);
        }
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

        // Bootstrap path is split in two stages so the persisted Ambilight
        // payload (saturation / blackBorderDetection / smoothing preset) gets
        // pushed to Rust on every boot — not only when Hue happens to be one
        // of the targets. Bug #39: previously the entire restore block was
        // gated on `targets.includes("hue") && hueBootstrapConfig`, so a
        // USB-only Ambilight session never re-applied its persisted knobs and
        // the worker came up with backend defaults (saturation 1.0 / black
        // borders off). The Hue branch still owns its own `startHue` +
        // `setHueSolidColor` orchestration; the new outer branch covers any
        // active mode regardless of the target mix.
        if (isActive) {
          // Filter targets against live USB availability so the Rust USB gate
          // doesn't reject the bootstrap apply on a Hue-only session that
          // happens to have "usb" persisted from a previous run.
          const bootTargets = restoredTargets.filter(
            (t) => t !== "usb" || bootstrapUsbAvailable,
          );

          if (restoredTargets.includes("hue") && hueBootstrapConfig) {
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
                  await setLightingMode(hydrateModePayload({
                    ...restoredMode,
                    targets: bootTargets,
                  }));
                }
              }
            } catch (err) {
              console.error("[LumaSync] Bootstrap Hue start/restore failed:", err);
            }
          } else if (
            restoredMode.kind === LIGHTING_MODE_KIND.AMBILIGHT &&
            bootTargets.length > 0
          ) {
            // USB-only (or Hue-not-configured) Ambilight bootstrap: push the
            // persisted payload to Rust so saturation / blackBorderDetection /
            // smoothing preset survive a restart. Without this branch the
            // worker uses backend defaults until the next manual mode toggle.
            try {
              await setLightingMode(hydrateModePayload({
                ...restoredMode,
                targets: bootTargets,
              }));
            } catch (err) {
              console.error("[LumaSync] Bootstrap USB-only Ambilight restore failed:", err);
            }
          } else if (
            restoredMode.kind === LIGHTING_MODE_KIND.SOLID &&
            restoredMode.solid &&
            bootTargets.includes("usb")
          ) {
            // USB-only Solid bootstrap: same rationale as above. The Solid
            // payload itself is small (RGB + brightness) but going through
            // setLightingMode keeps the backend's mode state machine aligned
            // with what the UI is showing on first paint.
            try {
              await setLightingMode(hydrateModePayload({
                ...restoredMode,
                targets: bootTargets,
              }));
            } catch (err) {
              console.error("[LumaSync] Bootstrap USB-only Solid restore failed:", err);
            }
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
  useEffect(() => { hueStartConfigRef.current = hueStartConfig; }, [hueStartConfig]);
  // Mirror the persisted LED calibration state into a ref so
  // `withLedCalibration` (called inside `dispatchSetLightingMode`) can
  // read the latest value without re-creating the helper on every render.
  // The ref is also primed at bootstrap (windowLifecycle hydration)
  // and on the calibration save callback so the very first dispatch
  // after either path already carries the right `totalLeds`.
  useEffect(() => { savedCalibrationRef.current = savedCalibration; }, [savedCalibration]);
  // v1.5 H1 — keep `savedAmbilightRef` aligned with the live ambilight
  // payload so subsequent dispatches (after the bootstrap prime) read
  // the user's most recent slider commits, not stale post-bootstrap data.
  useEffect(() => { savedAmbilightRef.current = lightingMode.ambilight; }, [lightingMode.ambilight]);
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

    // Delta-stop: for each removed target that is currently active, stop it.
    // A1.2 (v1.5.2): track per-target outcome via Promise.allSettled — only
    // successfully-stopped targets get pulled from active membership. A failed
    // stop leaves the chip active so the user can retry (and the next
    // dispatch sees a truthful activeOutputTargets), instead of the previous
    // behaviour where Promise.all + silent catch dropped the target from UI
    // state while the backend stream was still alive (root cause of the
    // HUE_STREAM_NOT_READY_ACTIVE_STREAMER 403 on the next start).
    type StopOutcome = { target: HueRuntimeTarget; ok: boolean };
    const stopResults = await Promise.allSettled(
      removedTargets.map(async (target): Promise<StopOutcome> => {
        if (!currentActive.includes(target)) return { target, ok: true };
        const command = target === "usb" ? "stop_lighting" : target === "hue" ? "stop_hue_stream" : null;
        if (!command) return { target, ok: true };
        try {
          await invoke(command);
          return { target, ok: true };
        } catch (err) {
          console.error(
            `[LumaSync] stop failed for target=${target}, retaining in activeOutputTargets:`,
            err,
          );
          return { target, ok: false };
        }
      })
    );
    const successfullyStopped = stopResults
      .filter((r): r is PromiseFulfilledResult<StopOutcome> => r.status === "fulfilled" && r.value.ok)
      .map((r) => r.value.target);
    const failedToStop = stopResults
      .filter((r): r is PromiseFulfilledResult<StopOutcome> => r.status === "fulfilled" && !r.value.ok)
      .map((r) => r.value.target);
    if (successfullyStopped.length > 0) {
      const nextActive = currentActive.filter((t) => !successfullyStopped.includes(t));
      setActiveOutputTargets(nextActive);
    }
    if (failedToStop.length > 0) {
      setStopFailedNotice(failedToStop);
      window.setTimeout(() => setStopFailedNotice(null), 5_000);
    }

    // Delta-start: for each added target, start the current mode on it
    for (const target of addedTargets) {
      if (target === "usb") {
        // Note: was previously using invoke("set_lighting_mode", { request: {...} })
        // which is the wrong key name (Tauri expects "payload") and silently failed.
        try {
          await dispatchSetLightingMode({
            kind: lightingMode.kind,
            solid: lightingMode.solid,
            ambilight: lightingMode.ambilight,
            targets: normalizedTargets,
          }, { force: true });
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
              await dispatchSetLightingMode({
                kind: lightingMode.kind,
                solid: lightingMode.solid,
                ambilight: lightingMode.ambilight,
                targets: normalizedTargets,
              }, { force: true });
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
  }, [lightingMode, selectedOutputTargets, hueStartConfig, hydrateModePayload, dispatchSetLightingMode]);

  // ---------------------------------------------------------------------------
  // Hot-plug detection: USB plug/unplug target management (D-07, D-08)
  // Guard: only runs after bootstrap has initialized prevUsbConnectedRef
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!bootstrapDone) return; // Skip until bootstrap sets ref and flag

    const wasConnected = prevUsbConnectedRef.current;

    if (wasConnected === false && isConnected) {
      // Bug 10C — auto-add "usb" to outputTargets on the false→true
      // transition (manual pair OR physical hot-plug). Pairing IS the
      // user's "I want USB output" intent; without this fix the Lights
      // output toggle stays `is-off` until a WebView reload, even though
      // the StatusBar USB pill flips to OK as soon as
      // `connectionEvents` propagates the new isConnected.
      //
      // We deliberately bypass `handleOutputTargetsChange` here:
      //   * its delta-start branch is gated on `lightingMode.kind !== OFF`
      //     (early-return at line ~968), so for a cold-launch pair where
      //     mode is OFF, the helper would only do `setSelectedOutputTargets`
      //     plus a `saveShellState`. We replicate that minimal pair below.
      //   * if a mode is already running, calling delta-start here would
      //     race against the bootstrap pipeline (start_hue_stream /
      //     dispatchSetLightingMode) for a target that is also being
      //     hydrated from persisted lastOutputTargets. Letting the next
      //     deliberate user action drive that path keeps the contract clean.
      //
      // Idempotent: the `includes` guard means a second pair on an
      // already-targeted USB session is a noop. The legacy
      // `showUsbSuggest` banner UI below is left in place (state /
      // handler / JSX / i18n keys) so a future opt-in flow can revive
      // the prompt; it just never fires on its own anymore.
      if (!selectedOutputTargets.includes("usb")) {
        const nextTargets = normalizeOutputTargets([...selectedOutputTargets, "usb"]);
        setSelectedOutputTargets(nextTargets);
        void saveShellState({ lastOutputTargets: nextTargets }).catch((err) => {
          console.error("[LumaSync] saveShellState(lastOutputTargets) on auto-add failed:", err);
        });
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

  // ---------------------------------------------------------------------------
  // Bug 10D — boot-time USB unsupported / missing fallback
  //
  // After commit 72fba5b ("reject non-USB serial ports up-front") the
  // backend rejects previously-accepted phantom ports (e.g.
  // /dev/cu.Bluetooth-Incoming-Port on macOS). Auto-reconnect on init
  // emits the rejection code via `connectionEvents`, but `selectedOutputTargets`
  // still includes "usb", so every subsequent `set_lighting_mode` invoke
  // hits the Rust USB gate and returns `DEVICE_NOT_CONNECTED` silently.
  // From the user's seat, "Ambilight does nothing".
  //
  // Fix: subscribe to the bus once, drop "usb" from targets on the
  // PORT_UNSUPPORTED / PORT_NOT_FOUND signal, persist via the existing
  // shellStore facade, and surface a one-time toast. We deliberately do
  // NOT call `handleOutputTargetsChange` (its delta-stop branch tries to
  // invoke `stop_lighting`, which is meaningless when nothing is running
  // — boot path is always at OFF until the user picks a mode).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const unsubscribe = connectionEvents.subscribe((event) => {
      if (event.connected || !event.unsupportedReason) return;
      const currentTargets = selectedOutputTargetsRef.current;
      const includedUsb = currentTargets.includes("usb");
      // Use the raw filter result. `normalizeOutputTargets([])` reverts to
      // DEFAULT_OUTPUT_TARGETS (= ["usb"]) which would silently re-add the
      // very target we are trying to drop, defeating the fallback.
      const filtered = currentTargets.filter((t) => t !== "usb") as HueRuntimeTarget[];
      // If the user has a paired Hue bridge and hue is not already in the
      // surviving targets, auto-add "hue" so Ambilight / Solid actually
      // produces output instead of leaving the user stranded at the OFF
      // state with no available sink. This also covers the case where a
      // prior session already auto-deselected USB and persisted `[]` —
      // boot lands here with `currentTargets === []`, no USB to drop, but
      // Hue must still get auto-added or the user has zero output sinks
      // and "ambilight does nothing" silently repeats.
      const huePaired = hueStartConfigRef.current !== null;
      const wantsHueAutoAdd = huePaired && !filtered.includes("hue");
      // If we have nothing to do (USB not in targets and no hue auto-add
      // needed) skip without persisting / toasting.
      if (!includedUsb && !wantsHueAutoAdd) return;
      const nextTargets: HueRuntimeTarget[] = wantsHueAutoAdd ? ["hue"] : filtered;
      setSelectedOutputTargets(nextTargets);
      void saveShellState({ lastOutputTargets: nextTargets }).catch((err) => {
        console.error(
          "[LumaSync] saveShellState(lastOutputTargets) on unsupported-port fallback failed:",
          err,
        );
      });
      setUsbUnsupportedNotice(true);
      window.setTimeout(() => setUsbUnsupportedNotice(false), 6_000);
    });
    return unsubscribe;
  }, []);

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
      const isQuickAmbilightAdjustment =
        normalizedNextMode.kind === LIGHTING_MODE_KIND.AMBILIGHT &&
        lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT;
      const isQuickAdjustment = isQuickSolidAdjustment || isQuickAmbilightAdjustment;

      // v1.5 fix #45 — quick adjustments BYPASS the transition lock-gate.
      //
      // Previously every dispatch was gated behind `modeTransitionLockRef`,
      // which queued every drag-tick into `pendingModeChangeRef` while a
      // slow-path transition was in flight. On lock release the queued
      // payload kicked off a new slow-path run (because the kind had
      // changed during the wait), set `isModeTransitioning = true`, and a
      // burst of follow-up drag ticks immediately re-queued behind that
      // new transition — leaving the UI with `isModeTransitioning` flipped
      // permanently true and every dock toggle disabled.
      //
      // Quick adjustments are idempotent live updates: same mode kind, just
      // a config nudge. They never need to coexist with a transition lock,
      // so we let them dispatch unconditionally and leave the lock-gate
      // strictly for kind-changing transitions.
      if (!isQuickAdjustment && modeTransitionLockRef.current) {
        pendingModeChangeRef.current = nextMode;
        return;
      }

      // Idempotent dispatch — skip the Tauri invoke when the outgoing
      // payload signature matches the last one we already sent. Keeps a
      // stuck subscriber or re-render storm from drowning the IPC bus
      // even though the throttle further upstream should already keep
      // call rate sane. Both quick paths now route through
      // `dispatchSetLightingMode` so the dedup ref is the single source
      // of truth — see the helper definition above for why the same
      // funnel covers hot-reload effects + delta-start re-applies.

      if (isQuickSolidAdjustment && normalizedNextMode.solid) {
        setLightingModeState(normalizedNextMode);
        scheduleLightingModePersist(normalizedNextMode);

        if (activeOutputTargets.includes("usb")) {
          void dispatchSetLightingMode(normalizedNextMode).catch((error) => {
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
        return;
      }

      // Fast path: ambilight already running and only settings changed (brightness,
      // smoothing, black border) — send live update without the full transition flow.
      // The Rust backend detects this case and updates live atomics in-place
      // (AMBILIGHT_MODE_UPDATED) without touching the worker or SCStream.
      // Same reasoning as isQuickSolidAdjustment — see note above. An ambilight
      // brightness nudge during a drag must never promote to the full transition
      // path just because target reconciliation is pending.
      if (isQuickAmbilightAdjustment) {
        setLightingModeState(normalizedNextMode);
        scheduleLightingModePersist(normalizedNextMode);
        void dispatchSetLightingMode(normalizedNextMode).catch((error) => {
          console.error("[LumaSync] Failed to push Ambilight settings update:", error);
        });
        return;
      }

      // Slow path: real mode-kind transition. Take the lock + flip the
      // transitioning flag so the dock surfaces a "switching outputs"
      // affordance instead of accepting a second click mid-flight.
      modeTransitionLockRef.current = true;
      // Reset the dedupe signature: a kind transition changes the payload
      // shape so the next quick adjustment after this completes must
      // always reach the backend.
      lastSentPayloadSignatureRef.current = null;
      setIsModeTransitioning(true);

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
            await dispatchSetLightingMode(normalizedNextMode, { force: true });
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
      dispatchSetLightingMode,
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
      savedCalibrationRef.current = config;
    },
    onCheckForUpdates: checkForUpdates,
    isCheckingForUpdates: updaterState.status === "checking",
    devSetUpdaterState,
    onHueIntensityPresetChange: (preset: HueIntensityPreset) => {
      hueIntensityPresetRef.current = preset;
      // Hot-reload an in-flight ambilight worker so the new preset takes
      // effect without a mode switch. For non-ambilight modes the preset
      // simply rides along on the next start_lighting_mode dispatch.
      // Routed through `dispatchSetLightingMode` so back-to-back identical
      // fires (re-render storm, double subscribe) collapse to a single
      // backend invoke instead of spamming the IPC bus.
      if (lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT) {
        void dispatchSetLightingMode(lightingMode).catch((error) => {
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
      // Routed through `dispatchSetLightingMode` so an identical re-fire
      // is dropped — see Hue intensity preset comment for the why.
      colorCorrectionRef.current = next;
      void dispatchSetLightingMode(lightingMode).catch((error) => {
        console.error("[LumaSync] Failed to hot-reload color correction:", error);
      });
    },
    onFirmwareProfileChange: (next: FirmwareProfile) => {
      // FirmwareProfilePicker already persisted via shellStore.save() on
      // commit; mirror into the ref + trigger a worker restart with the
      // new protocol. Changing firmware profile is a wire-format change
      // on the Rust side so a silent flicker is expected — the USB
      // encoder pipeline rebuilds before the next frame. Routed through
      // `dispatchSetLightingMode` (force=true) so the backend always
      // sees the new profile bytes even when the FE signature happened
      // to match a prior fire.
      firmwareProfileRef.current = next;
      void dispatchSetLightingMode(lightingMode, { force: true }).catch((error) => {
        console.error("[LumaSync] Failed to hot-reload firmware profile:", error);
      });
    },
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
      {usbUnsupportedNotice && (
        <div
          className="fixed bottom-4 right-4 z-50 rounded-lg px-4 py-3 shadow-lg flex items-center gap-2"
          role="status"
          aria-live="polite"
          style={{
            background: "var(--lm-panel-2)",
            border: "1px solid var(--lm-line-2)",
            color: "var(--lm-ink)",
            // Stack above usbDisconnectNotice / stopFailedNotice if any
            // ever co-fire — boot-time signal should sit highest.
            transform:
              usbDisconnectNotice || (stopFailedNotice && stopFailedNotice.length > 0)
                ? "translateY(-3.5rem)"
                : undefined,
          }}
        >
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--lm-amber)" }} />
          <span style={{ fontSize: "12px", color: "var(--lm-muted)" }}>
            {t("hotplug.unsupportedFallback")}
          </span>
        </div>
      )}
      {stopFailedNotice && stopFailedNotice.length > 0 && (
        <div
          className="fixed bottom-4 right-4 z-50 rounded-lg px-4 py-3 shadow-lg flex items-center gap-2"
          role="status"
          aria-live="polite"
          style={{
            background: "var(--lm-panel-2)",
            border: "1px solid var(--lm-red, #f87171)",
            color: "var(--lm-ink)",
            // Stack above usbDisconnectNotice if both ever co-fire (rare; sequential).
            transform: usbDisconnectNotice ? "translateY(-3.5rem)" : undefined,
          }}
        >
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--lm-red, #f87171)" }} />
          <span style={{ fontSize: "12px", color: "var(--lm-muted)" }}>
            {t("hotplug.stopFailed", {
              targets: stopFailedNotice
                .map((target) => t(`hotplug.targetLabel.${target}` as const))
                .join(", "),
            })}
          </span>
        </div>
      )}
    </>
  );
}

export default App;
