import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import {
  MODE_GUARD_REASONS,
  type ModeGuardReason,
} from "../../mode/state/modeGuard";
import {
  EDGE_SIGNAL_EVENT,
  LIGHTING_MODE_KIND,
  normalizeLightingModeConfig,
  normalizeAmbilightPayload,
  type EdgeSignalPayload,
  type LightingModeConfig,
} from "../../mode/model/contracts";
import {
  SCENE_PRESETS,
  findMatchingScenePreset,
  type ScenePreset,
} from "../../mode/model/scenePresets";
import { HUE_ZONE_COMMANDS, type HueIntensityPreset, type HueRuntimeTarget } from "../../../shared/contracts/hue";
import type { HueZone, RoomMapConfig } from "../../../shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "../../../shared/contracts/roomMap";
import type { DisplayInfo } from "../../../shared/contracts/display";
import {
  FIRMWARE_PROFILE,
  type ColorCorrectionConfig,
  type FirmwareProfile,
} from "../../../shared/contracts/device";
import {
  KEYBIND_ACTIONS,
  type KeybindAction,
  getKeybindDefinition,
  resolveKeybindPlatform,
} from "../../../shared/contracts/shell";
import { listDisplays } from "../../calibration/calibrationApi";
import type { LedCalibrationConfig } from "../../calibration/model/contracts";
import { getFullTelemetrySnapshot } from "../../telemetry/telemetryApi";
import type { RuntimeTelemetrySnapshot } from "../../telemetry/model/contracts";
import { shellStore } from "../../persistence/shellStore";
import { OnboardingBanner } from "../../../shared/ui/OnboardingBanner";

import { SolidColorPanel } from "./control/SolidColorPanel";
import { ColorCorrectionPanel } from "./control/ColorCorrectionPanel";
import { FirmwareProfilePicker } from "./control/FirmwareProfilePicker";
import { LightingSmoothingPresetControl } from "./control/LightingSmoothingPresetControl";

const TELEMETRY_POLL_INTERVAL_MS = 1000;

function rgbTripletToCss(triplet: [number, number, number]): string {
  return `rgb(${triplet[0]},${triplet[1]},${triplet[2]})`;
}

function buildLinearGradient(
  direction: "to right" | "to bottom",
  samples: Array<[number, number, number]>,
): string | undefined {
  if (samples.length === 0) return undefined;
  if (samples.length === 1) return rgbTripletToCss(samples[0]);
  return `linear-gradient(${direction},${samples.map(rgbTripletToCss).join(",")})`;
}

export interface LightsModeLockState {
  reason: ModeGuardReason | null;
  showReason: boolean;
  showOpenCalibrationAction: boolean;
}

export function getLightsModeLockState(reason: ModeGuardReason | null): LightsModeLockState {
  const calibrationRequired = reason === MODE_GUARD_REASONS.CALIBRATION_REQUIRED;
  return {
    reason,
    showReason: calibrationRequired,
    showOpenCalibrationAction: calibrationRequired,
  };
}

export function triggerCalibrationFromLock(
  lockState: LightsModeLockState,
  openCalibration: () => void,
): void {
  if (lockState.showOpenCalibrationAction) openCalibration();
}

interface LightsSectionProps {
  mode: LightingModeConfig;
  outputTargets: HueRuntimeTarget[];
  usbConnected: boolean;
  hueConfigured: boolean;
  hueReachable?: boolean;
  hueStreaming: boolean;
  calibration?: LedCalibrationConfig;
  modeLockReason: ModeGuardReason | null;
  isModeTransitioning?: boolean;
  onModeChange: (nextMode: LightingModeConfig) => void;
  onOutputTargetsChange: (targets: HueRuntimeTarget[]) => void;
  onOpenCalibration: () => void;
  /**
   * Fired when the user picks a new Hue intensity preset. The parent
   * persists to shellStore AND hot-reloads the running worker so the new
   * preset takes effect without a mode toggle.
   */
  onHueIntensityPresetChange?: (preset: HueIntensityPreset) => void;
  /**
   * Fired when the ColorCorrectionPanel commits a new config (the panel
   * already persists internally; this hook is reserved for future
   * worker-hot-reload — current v1.4 Rust path reads persisted state on
   * the next set_lighting_mode so no explicit invoke is required here).
   */
  onColorCorrectionChange?: (next: ColorCorrectionConfig) => void;
  /**
   * Fired when the FirmwareProfilePicker commits a new profile. Parent
   * mirrors the ref + hot-reloads via set_lighting_mode so the Rust
   * encoder swap takes effect on the next frame without a mode toggle.
   */
  onFirmwareProfileChange?: (next: FirmwareProfile) => void;
}

function toHexPair(value: number): string {
  return Math.max(0, Math.min(255, Math.floor(value))).toString(16).padStart(2, "0");
}

function IconOff() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <line x1="5" y1="5" x2="19" y2="19" />
    </svg>
  );
}

function IconAmbilight() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5.5" width="18" height="12" rx="1.5" />
      <path d="M2 9l2-2M22 9l-2-2M2 14l2 2M22 14l-2 2" />
    </svg>
  );
}

function IconSolid() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
    </svg>
  );
}

/**
 * Render a keybind badge (modifier + key) for a mode button. Badge labels
 * come from the shared KEYBIND_REGISTRY so StatusBar + LightsSection stay
 * in sync with the handler map wired in `useGlobalKeybinds`.
 */
function ModeKeybindBadge({ action }: { action: KeybindAction }) {
  const platform = useMemo(() => resolveKeybindPlatform(), []);
  const definition = useMemo(
    () => getKeybindDefinition(action, platform),
    [action, platform],
  );
  return <span className="kb">{definition.badge.join("")}</span>;
}

export function LightsSection({
  mode,
  outputTargets,
  usbConnected,
  hueConfigured,
  hueReachable = true,
  hueStreaming,
  calibration,
  modeLockReason,
  isModeTransitioning = false,
  onModeChange,
  onOutputTargetsChange,
  onOpenCalibration,
  onHueIntensityPresetChange,
  onColorCorrectionChange,
  onFirmwareProfileChange,
}: LightsSectionProps) {
  const { t } = useTranslation("common");
  const lockState = getLightsModeLockState(modeLockReason);
  const modeSelectorDisabled = lockState.showReason || isModeTransitioning;
  const normalizedMode = normalizeLightingModeConfig(mode);
  const activeKind = normalizedMode.kind;
  const isOff = activeKind === LIGHTING_MODE_KIND.OFF;
  const isSolid = activeKind === LIGHTING_MODE_KIND.SOLID;
  const isAmbilight = activeKind === LIGHTING_MODE_KIND.AMBILIGHT;
  const incomingSolid = normalizedMode.solid ?? { r: 255, g: 255, b: 255, brightness: 1 };
  const incomingAmbilight = normalizeAmbilightPayload(normalizedMode.ambilight);

  const solidHex = `#${toHexPair(incomingSolid.r)}${toHexPair(incomingSolid.g)}${toHexPair(incomingSolid.b)}`;
  const solidBrightnessPct = Math.round(incomingSolid.brightness * 100);

  // Scene selection is derived from the active SOLID color, not stored
  // locally — that keeps the highlight in sync with the persisted mode
  // across reloads and across the Compact/Lights views.
  const activeScenePreset = isSolid ? findMatchingScenePreset(incomingSolid) : undefined;

  // ── v1.4 persisted device/runtime knobs ──────────────────────────────
  // Hydrated once from shellStore and refreshed through the child control
  // callbacks. Kept in state here so the LED advanced-settings panels +
  // the SolidColorPanel brightness lock stay in sync without prop drilling
  // through App.tsx for every knob.
  const [initialColorCorrection, setInitialColorCorrection] =
    useState<ColorCorrectionConfig | undefined>(undefined);
  const [firmwareProfile, setFirmwareProfile] = useState<FirmwareProfile | undefined>(undefined);
  const [initialHueIntensityPreset, setInitialHueIntensityPreset] =
    useState<HueIntensityPreset | undefined>(undefined);
  const [advancedHydrated, setAdvancedHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        setInitialColorCorrection(state.colorCorrection);
        setFirmwareProfile(state.firmwareProfile);
        setInitialHueIntensityPreset(state.lightingIntensityPreset);
        setAdvancedHydrated(true);
      })
      .catch((error) => {
        console.error(
          "[LumaSync] LightsSection advanced-settings hydrate failed:",
          error,
        );
        if (!cancelled) setAdvancedHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Hue zone authoring (v1.5 W1-A5) ──────────────────────────────
  // Track the persisted entertainment area so the dock "+" CTA is only
  // enabled when the user has finished Hue onboarding. We do not mount
  // the full useHueOnboarding state machine here; the area id alone is
  // enough to author a logical zone.
  const [lastHueAreaId, setLastHueAreaId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void shellStore.load().then((state) => {
      if (cancelled) return;
      setLastHueAreaId(state.lastHueAreaId ?? null);
    }).catch((error) => {
      console.error("[LumaSync] LightsSection hueAreaId hydrate failed:", error);
    });
    return () => { cancelled = true; };
  }, []);

  const canAddHueZone = hueConfigured && hueReachable && lastHueAreaId !== null;

  const handleAddHueZone = useCallback(async () => {
    if (!canAddHueZone || !lastHueAreaId) return;
    try {
      const state = await shellStore.load();
      const currentMap: RoomMapConfig = state.roomMap ?? DEFAULT_ROOM_MAP;
      const existing = currentMap.hueZones ?? [];
      const id = `hue-zone-${crypto.randomUUID()}`;
      const palette = ["--lm-zone-1", "--lm-zone-2", "--lm-zone-3", "--lm-zone-4", "--lm-zone-5", "--lm-zone-6"];
      const colorVar = `var(${palette[existing.length % palette.length]})`;
      const newZone: HueZone = {
        id,
        name: t("roomMap.hueZones.defaultName", { N: String(existing.length + 1) }),
        entertainmentAreaId: lastHueAreaId,
        centerX: 0,
        centerY: 0,
        centerZ: 0,
        scaleX: 0.5,
        scaleY: 0.5,
        scaleZ: 0.5,
        channelIndices: [],
        borderColor: colorVar,
        centerColor: colorVar,
      };
      const nextMap: RoomMapConfig = {
        ...currentMap,
        hueZones: [...existing, newZone],
      };
      await shellStore.save({
        roomMap: nextMap,
        roomMapVersion: (state.roomMapVersion ?? 0) + 1,
      });
      try {
        await invoke(HUE_ZONE_COMMANDS.CREATE_HUE_ZONE, { zone: newZone });
      } catch (invokeErr) {
        console.error("[LumaSync] create_hue_zone failed", invokeErr);
      }
    } catch (error) {
      console.error("[LumaSync] handleAddHueZone failed:", error);
    }
  }, [canAddHueZone, lastHueAreaId, t]);

  const isAdalight = firmwareProfile === FIRMWARE_PROFILE.ADALIGHT;

  const handleScenePresetClick = (preset: ScenePreset) => {
    onModeChange({
      kind: LIGHTING_MODE_KIND.SOLID,
      solid: {
        r: preset.r,
        g: preset.g,
        b: preset.b,
        brightness: isSolid ? incomingSolid.brightness : preset.brightness,
      },
    });
  };

  // Compute USB/Hue availability + selection.
  const usbSelected = outputTargets.includes("usb");
  const hueSelected = outputTargets.includes("hue");
  const hueAvailable = hueConfigured && hueReachable;

  const toggleTarget = (id: HueRuntimeTarget, currentlySelected: boolean) => {
    const next = currentlySelected
      ? outputTargets.filter((target) => target !== id)
      : [...outputTargets, id];
    if (next.length > 0) onOutputTargetsChange(next);
  };

  const toggleBlackBorder = () => {
    onModeChange({
      kind: LIGHTING_MODE_KIND.AMBILIGHT,
      ambilight: {
        ...incomingAmbilight,
        blackBorderDetection: !incomingAmbilight.blackBorderDetection,
      },
    });
  };

  // Slider shows saturation as a 50–200% dial; payload is a 0.5–2.0 factor.
  const handleSaturationChange = (percent: number) => {
    onModeChange({
      kind: LIGHTING_MODE_KIND.AMBILIGHT,
      ambilight: { ...incomingAmbilight, saturation: percent / 100 },
    });
  };

  // v1.5 W2 fix #40 — Ambilight brightness used to live only in the
  // CompactLayout. Mirrored here so the full-mode Lights view exposes
  // the same control set; payload field is `ambilight.brightness`
  // (0..1 unit), surfaced as a 0..100% dial.
  const handleAmbilightBrightnessChange = (percent: number) => {
    onModeChange({
      kind: LIGHTING_MODE_KIND.AMBILIGHT,
      ambilight: { ...incomingAmbilight, brightness: percent / 100 },
    });
  };
  const ambilightBrightnessPct = Math.round((incomingAmbilight.brightness ?? 1) * 100);

  const totalLeds = calibration?.totalLeds;

  // Poll runtime telemetry while Ambilight is active so the meta pill
  // (Δ latency / Σ fps) reflects live worker state. Paused when tab hidden
  // or when any other mode is selected — nothing to measure otherwise.
  const [liveTelemetry, setLiveTelemetry] = useState<RuntimeTelemetrySnapshot | null>(null);
  useEffect(() => {
    if (!isAmbilight) {
      setLiveTelemetry(null);
      return;
    }
    let mounted = true;
    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const snap = await getFullTelemetrySnapshot();
        if (mounted) setLiveTelemetry(snap.usb);
      } catch {
        /* swallow — next tick retries */
      }
    };
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, TELEMETRY_POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      window.clearInterval(id);
    };
  }, [isAmbilight]);

  const latencyLabel = liveTelemetry ? `${Math.round(liveTelemetry.frameLatencyMs)}ms` : "—";
  const fpsLabel = liveTelemetry ? `${Math.round(liveTelemetry.sendFps)} fps` : "—";

  // Edge signal preview — streamed from the ambilight worker (~10 Hz).
  // Subscribe only while Ambilight mode is active to avoid unnecessary IPC traffic.
  const [edgeSignal, setEdgeSignal] = useState<EdgeSignalPayload | null>(null);
  useEffect(() => {
    if (!isAmbilight) {
      setEdgeSignal(null);
      return;
    }
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen<EdgeSignalPayload>(EDGE_SIGNAL_EVENT, (event) => {
      if (!cancelled) setEdgeSignal(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isAmbilight]);

  // Primary display info for the edge center tile. Loaded once on mount.
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    listDisplays()
      .then((result) => {
        if (!cancelled) setDisplays(result);
      })
      .catch(() => {
        if (!cancelled) setDisplays([]);
      });
    return () => { cancelled = true; };
  }, []);

  const primaryDisplay = displays.find((d) => d.isPrimary) ?? displays[0];
  const displayIndex = primaryDisplay
    ? Math.max(1, displays.findIndex((d) => d.id === primaryDisplay.id) + 1)
    : 1;
  const resolutionLabel = primaryDisplay
    ? `${primaryDisplay.width} × ${primaryDisplay.height}`
    : null;

  const edgeGradients = useMemo(() => ({
    top: edgeSignal ? buildLinearGradient("to right", edgeSignal.top) : undefined,
    bottom: edgeSignal ? buildLinearGradient("to right", edgeSignal.bottom) : undefined,
    left: edgeSignal ? buildLinearGradient("to bottom", edgeSignal.left) : undefined,
    right: edgeSignal ? buildLinearGradient("to bottom", edgeSignal.right) : undefined,
  }), [edgeSignal]);

  const counts = calibration?.counts;

  const saturationValue = Math.round((incomingAmbilight.saturation ?? 1) * 100);
  const saturationFillPercent = Math.round(((saturationValue - 50) / 150) * 100);
  const blackBorderOn = incomingAmbilight.blackBorderDetection ?? false;

  const slidersDisabled = !isAmbilight || modeSelectorDisabled;
  // Adalight (firmware-fixed brightness) gets the same lock parity as
  // SolidColorPanel. Locking is OR-ed with the standard slider disable
  // so the slider tooltip surfaces the firmware reason while transient
  // mode-transition disables stay generic.
  const ambilightBrightnessLocked = isAdalight || slidersDisabled;

  return (
    <div className="lm-lights-page">
      {/* ── Center column ─────────────────────────────────────────────── */}
      <div className="lm-lights-center">
        {lockState.showReason && (
          <OnboardingBanner
            title={t("lightsPage.calibrationBanner.title")}
            body={t("lightsPage.calibrationBanner.sub")}
            primaryAction={{
              label: t("lightsPage.calibrationBanner.action"),
              onClick: onOpenCalibration,
            }}
          />
        )}

        {/* Mode strip */}
        <div>
          <div className="lm-lights-slab">
            {t("lightsPage.slab.modeText")} <b>{t("lightsPage.slab.modeAccent")}</b>
          </div>
          <div className="lm-mstrip" role="group">
            <button
              type="button"
              className={`lm-mbtn ${isOff ? "is-on" : ""}`}
              disabled={modeSelectorDisabled}
              aria-pressed={isOff}
              onClick={() => onModeChange({ kind: LIGHTING_MODE_KIND.OFF })}
            >
              <span className="ico"><IconOff /></span>
              <span className="tx">
                <span className="tn">{t("lightsPage.mode.off.title")}</span>
                <span className="ts">{t("lightsPage.mode.off.subtitle")}</span>
              </span>
              <ModeKeybindBadge action={KEYBIND_ACTIONS.MODE_OFF} />
            </button>
            <button
              type="button"
              className={`lm-mbtn ${isAmbilight ? "is-on" : ""}`}
              disabled={modeSelectorDisabled}
              aria-pressed={isAmbilight}
              onClick={() =>
                onModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT, ambilight: incomingAmbilight })
              }
            >
              <span className="ico"><IconAmbilight /></span>
              <span className="tx">
                <span className="tn">{t("lightsPage.mode.ambilight.title")}</span>
                <span className="ts">
                  {typeof totalLeds === "number" && totalLeds > 0
                    ? t("lightsPage.mode.ambilight.subtitle", { count: totalLeds })
                    : t("lightsPage.mode.ambilight.subtitleFallback")}
                </span>
              </span>
              <ModeKeybindBadge action={KEYBIND_ACTIONS.MODE_AMBILIGHT} />
            </button>
            <button
              type="button"
              className={`lm-mbtn ${isSolid ? "is-on" : ""}`}
              disabled={modeSelectorDisabled}
              aria-pressed={isSolid}
              onClick={() =>
                onModeChange({
                  kind: LIGHTING_MODE_KIND.SOLID,
                  solid: { ...incomingSolid },
                })
              }
            >
              <span className="ico"><IconSolid /></span>
              <span className="tx">
                <span className="tn">{t("lightsPage.mode.solid.title")}</span>
                <span className="ts">
                  {t("lightsPage.mode.solid.subtitle", {
                    hex: solidHex.toUpperCase(),
                    brightness: solidBrightnessPct,
                  })}
                </span>
              </span>
              <ModeKeybindBadge action={KEYBIND_ACTIONS.MODE_SOLID} />
            </button>
          </div>
        </div>

        {/* Solid color picker — inline when solid mode is active */}
        {isSolid && (
          <div
            style={{
              background: "#0e1014",
              border: "1px solid #1a1e25",
              borderRadius: 10,
              padding: 14,
            }}
          >
            <SolidColorPanel
              incoming={incomingSolid}
              disabled={lockState.showReason}
              brightnessDisabled={isAdalight}
              brightnessDisabledReason={
                isAdalight
                  ? t("ledSettings.firmwareProfile.brightnessDisabledTooltip")
                  : undefined
              }
              onCommit={(draft) =>
                onModeChange({ kind: LIGHTING_MODE_KIND.SOLID, solid: draft })
              }
            />
          </div>
        )}

        {/* Edge signal + profile — only when Ambilight is active */}
        {isAmbilight && <div>
          <div className="lm-lights-slab">
            {t("lightsPage.slab.signalText")} <b>{t("lightsPage.slab.signalAccent")}</b>
          </div>
          <div className="lm-signal">
            <div className="lm-signal-head">
              <span className="l">{t("lightsPage.signal.title")}</span>
              <span className="meta-pill">
                <span>
                  {t("lightsPage.signal.delta")} <b>{latencyLabel}</b>
                </span>
                <span>
                  {t("lightsPage.signal.fps")} <b>{fpsLabel}</b>
                </span>
              </span>
            </div>
            <div className="lm-edges" aria-label={t("lightsPage.signal.edgesAria")}>
              <div
                className="lm-edge lm-edge-top"
                style={edgeGradients.top ? { background: edgeGradients.top } : undefined}
              >
                <span className="label">
                  {t("lightsPage.signal.edges.top", { count: counts?.top ?? 0 })}
                </span>
              </div>
              <div
                className="lm-edge lm-edge-l"
                style={edgeGradients.left ? { background: edgeGradients.left } : undefined}
              >
                <span className="label">
                  {t("lightsPage.signal.edges.left", { count: counts?.left ?? 0 })}
                </span>
              </div>
              <div className="lm-edge lm-edge-c">
                <div className="scene">
                  <b>{t("lightsPage.signal.display.label", { index: displayIndex })}</b>
                  {resolutionLabel ?? t("lightsPage.signal.display.sub")}
                </div>
              </div>
              <div
                className="lm-edge lm-edge-r"
                style={edgeGradients.right ? { background: edgeGradients.right } : undefined}
              >
                <span className="label">
                  {t("lightsPage.signal.edges.right", { count: counts?.right ?? 0 })}
                </span>
              </div>
              <div
                className="lm-edge lm-edge-bot"
                style={edgeGradients.bottom ? { background: edgeGradients.bottom } : undefined}
              >
                <span className="label">
                  {t("lightsPage.signal.edges.bot", { count: counts?.bottom ?? 0 })}
                </span>
              </div>
            </div>
            {advancedHydrated && (
              <LightingSmoothingPresetControl
                initialPreset={initialHueIntensityPreset}
                onPresetChange={(next) => {
                  setInitialHueIntensityPreset(next);
                  onHueIntensityPresetChange?.(next);
                }}
              />
            )}
            <div className="lm-profile">
              {/* Brightness — wired to AmbilightPayload.brightness (0..1).
                  Adalight firmware does not carry a brightness byte, so the
                  control falls into a visible-but-disabled state with the
                  shared firmware-profile tooltip — same parity logic as
                  the SolidColorPanel brightness slider. */}
              <div className="lm-psl">
                <div className="row">
                  <span>{t("lightsPage.signal.profile.brightness")}</span>
                  <b>{ambilightBrightnessPct}%</b>
                </div>
                <div className="tr">
                  <div className="tr-track">
                    <span className="tr-fill" style={{ width: `${ambilightBrightnessPct}%` }} />
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={ambilightBrightnessPct}
                    disabled={ambilightBrightnessLocked}
                    aria-disabled={ambilightBrightnessLocked}
                    aria-label={t("lightsPage.signal.profile.brightness")}
                    title={
                      isAdalight
                        ? t("ledSettings.firmwareProfile.brightnessDisabledTooltip")
                        : undefined
                    }
                    onChange={(e) => handleAmbilightBrightnessChange(parseInt(e.target.value, 10))}
                  />
                </div>
              </div>
              {/* Saturation — wired to AmbilightPayload.saturation (0.5–2.0). */}
              <div className="lm-psl">
                <div className="row">
                  <span>{t("lightsPage.signal.profile.saturation")}</span>
                  <b>{saturationValue}%</b>
                </div>
                <div className="tr">
                  <div className="tr-track">
                    <span className="tr-fill" style={{ width: `${saturationFillPercent}%` }} />
                  </div>
                  <input
                    type="range"
                    min={50}
                    max={200}
                    step={1}
                    value={saturationValue}
                    disabled={slidersDisabled}
                    aria-label={t("lightsPage.signal.profile.saturation")}
                    onChange={(e) => handleSaturationChange(parseInt(e.target.value, 10))}
                  />
                </div>
              </div>
              {/* Black border — toggle */}
              <div className="lm-psl is-toggle">
                <div className="row">
                  <span>{t("lightsPage.signal.profile.blackBorder")}</span>
                  <b>
                    {blackBorderOn
                      ? t("lightsPage.signal.profile.blackBorderAuto")
                      : t("lightsPage.signal.profile.blackBorderOff")}
                  </b>
                </div>
                <div className="tr">
                  <button
                    type="button"
                    className="tr-toggle"
                    disabled={slidersDisabled}
                    aria-pressed={blackBorderOn}
                    onClick={toggleBlackBorder}
                  >
                    <div className="tr-track" style={{ width: "100%" }}>
                      <span
                        className="tr-fill"
                        style={{ width: blackBorderOn ? "100%" : "0%" }}
                      />
                    </div>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>}

        {/* Scene presets — click switches to SOLID with the preset RGB.
            Highlight is derived from the active solid color so it stays
            in sync after reloads and Compact-view edits. */}
        <div>
          <div className="lm-lights-slab">
            {t("lightsPage.slab.scenesText")} <b>{t("lightsPage.slab.scenesAccent")}</b>
          </div>
          <div className="lm-scenes">
            {SCENE_PRESETS.map((preset) => {
              const isSelected = activeScenePreset?.id === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  disabled={modeSelectorDisabled}
                  className={`lm-sc ${isSelected ? "is-sel" : ""}`}
                  style={{ background: preset.gradient }}
                  aria-pressed={isSelected}
                  onClick={() => handleScenePresetClick(preset)}
                >
                  <b>{t(preset.labelKey)}</b>
                </button>
              );
            })}
          </div>
        </div>

        {/* v1.4 advanced LED / Hue controls.
            Hydrated asynchronously so `initial*` props are defined before
            the child components mount — a bare mount with undefined
            initial values would cause the children to flash the DEFAULT
            config for one frame before the async read lands. */}
        {advancedHydrated && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <FirmwareProfilePicker
              initialProfile={firmwareProfile}
              onProfileChange={(next) => {
                setFirmwareProfile(next);
                onFirmwareProfileChange?.(next);
              }}
            />
            <ColorCorrectionPanel
              initialConfig={initialColorCorrection}
              onConfigChange={(next) => {
                setInitialColorCorrection(next);
                onColorCorrectionChange?.(next);
              }}
            />
          </div>
        )}
      </div>

      {/* ── Right dock ────────────────────────────────────────────────── */}
      <aside className="lm-dock" aria-label={t("lightsPage.dock.outputs")}>
        <div>
          <h4>
            <span className="t">{t("lightsPage.dock.outputs")}</span>
            <button
              type="button"
              className="add"
              disabled={!canAddHueZone}
              aria-disabled={!canAddHueZone}
              aria-label={t("lightsPage.dock.addAria")}
              title={
                canAddHueZone
                  ? t("lightsPage.dock.addHueZoneTooltip")
                  : t("lightsPage.dock.addDisabledTooltip")
              }
              onClick={canAddHueZone ? () => { void handleAddHueZone(); } : undefined}
            >
              +
            </button>
          </h4>
          <div className="lm-out-list">
            {/* USB row */}
            <button
              type="button"
              className={`lm-out-row ${
                !usbConnected ? "is-unavailable" : usbSelected ? "" : "is-off"
              }`}
              disabled={modeSelectorDisabled || !usbConnected || (usbSelected && outputTargets.length === 1)}
              onClick={() => toggleTarget("usb", usbSelected)}
              aria-pressed={usbSelected}
            >
              <span className="st" />
              <div className="tx">
                <div className="n">
                  {t("lightsPage.dock.rows.usbName")}{" "}
                  <em>{t("lightsPage.dock.rows.usbType")}</em>
                </div>
                <div className="s">
                  {usbConnected ? (
                    <Trans
                      i18nKey="lightsPage.dock.rows.usbSub"
                      values={{ count: totalLeds ?? 0 }}
                      components={{ b: <b /> }}
                    />
                  ) : (
                    t("lightsPage.dock.rows.usbSubUnavailable")
                  )}
                </div>
              </div>
              <span className="tg" />
            </button>
            {/* Hue row */}
            <button
              type="button"
              className={`lm-out-row ${
                !hueAvailable ? "is-unavailable" : hueSelected ? "" : "is-off"
              }`}
              disabled={modeSelectorDisabled || !hueAvailable || (hueSelected && outputTargets.length === 1)}
              onClick={() => toggleTarget("hue", hueSelected)}
              aria-pressed={hueSelected}
            >
              <span className="st" />
              <div className="tx">
                <div className="n">
                  {t("lightsPage.dock.rows.hueName")}{" "}
                  <em>{t("lightsPage.dock.rows.hueType")}</em>
                </div>
                <div className="s">
                  {!hueAvailable ? (
                    t("lightsPage.dock.rows.hueSubUnavailable")
                  ) : hueStreaming ? (
                    <Trans
                      i18nKey="lightsPage.dock.rows.hueSubStreaming"
                      components={{ b: <b /> }}
                    />
                  ) : (
                    <Trans
                      i18nKey="lightsPage.dock.rows.hueSubIdle"
                      components={{ b: <b /> }}
                    />
                  )}
                </div>
              </div>
              <span className="tg" />
            </button>
          </div>
        </div>

        <div className="lm-hint-box">
          <b>{t("lightsPage.dock.hintTitle")}</b>
          {t("lightsPage.dock.hintBody")
            .split("\n")
            .map((line, idx, arr) => (
              <span key={idx}>
                {line}
                {idx < arr.length - 1 && <br />}
              </span>
            ))}
        </div>
      </aside>
    </div>
  );
}
