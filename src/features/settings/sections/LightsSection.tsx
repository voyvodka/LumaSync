import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation, Trans } from "react-i18next";

import {
  MODE_GUARD_REASONS,
  type ModeGuardReason,
} from "@/features/mode/state/modeGuard";
import {
  LIGHTING_MODE_KIND,
  normalizeLightingModeConfig,
  normalizeAmbilightPayload,
  type LightingModeConfig,
} from "@/features/mode/model/contracts";
import {
  SCENE_PRESETS,
  findMatchingScenePreset,
  type ScenePreset,
} from "@/features/mode/model/scenePresets";
import type { HueIntensityPreset, HueRuntimeTarget } from "@/shared/contracts/hue";
import { createHueZone } from "@/features/room-map/roomMapApi";
import type { HueZone, RoomMapConfig } from "@/shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import type { DisplayInfo } from "@/shared/contracts/display";
import {
  FIRMWARE_PROFILE,
  type ColorCorrectionConfig,
  type FirmwareProfile,
} from "@/shared/contracts/device";
import {
  KEYBIND_ACTIONS,
  type KeybindAction,
  getKeybindDefinition,
  resolveKeybindPlatform,
} from "@/shared/contracts/shell";
import { listDisplays } from "@/features/calibration/calibrationApi";
import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import { useFullTelemetryPoll } from "@/features/telemetry/hooks/useFullTelemetryPoll";
import { hasSerialLinkBudget } from "@/shared/contracts/telemetry";
import { shellStore } from "@/features/persistence/shellStore";
import { OnboardingBanner } from "@/shared/ui/OnboardingBanner";
import { IconOff, IconAmbilight, IconSolid } from "@/shared/ui/icons";

import { EdgeSignalGrid } from "./EdgeSignalGrid";
import { SolidColorPanel } from "./control/SolidColorPanel";
import { ColorCorrectionPanel } from "./control/ColorCorrectionPanel";
import { FirmwareProfilePicker } from "./control/FirmwareProfilePicker";
import { LightingSmoothingPresetControl } from "./control/LightingSmoothingPresetControl";

const TELEMETRY_POLL_INTERVAL_MS = 1000;

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
  /** The bridge probe stopped after a sustained outage; the banner offers a retry. */
  hueProbeGaveUp?: boolean;
  /** A bridge probe is in flight, so the retry control shows pending. */
  hueProbeChecking?: boolean;
  onRetryHueProbe?: () => void;
  hueStreaming: boolean;
  calibration?: LedCalibrationConfig;
  modeLockReason: ModeGuardReason | null;
  isModeTransitioning?: boolean;
  onModeChange: (nextMode: LightingModeConfig) => void;
  onOutputTargetsChange: (targets: HueRuntimeTarget[]) => void;
  onOpenCalibration: () => void;
  /** Deep-link into DEVICES from the offline banner — full-mode twin of `CompactLayout.onOpenDevices`. */
  onOpenDevices?: () => void;
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
  hueProbeGaveUp = false,
  hueProbeChecking = false,
  onRetryHueProbe,
  hueStreaming,
  calibration,
  modeLockReason,
  isModeTransitioning = false,
  onModeChange,
  onOutputTargetsChange,
  onOpenCalibration,
  onOpenDevices,
  onHueIntensityPresetChange,
  onColorCorrectionChange,
  onFirmwareProfileChange,
}: LightsSectionProps) {
  const { t } = useTranslation();
  const lockState = getLightsModeLockState(modeLockReason);
  const modeSelectorDisabled = lockState.showReason || isModeTransitioning;
  // Without a reachable sink an activated mode spins up a worker with nowhere to
  // send frames; a configured-but-offline bridge is not one, hence the two Hue terms.
  const outputMissing = !(usbConnected || (hueConfigured && hueReachable));
  const nonOffModeDisabled = modeSelectorDisabled || outputMissing;
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
      // `zones` is the only zone array the room map renders; `hueZones` is a
      // one-shot migration input. See docs/architecture/hue.md.
      const existing = currentMap.zones ?? [];
      const id = `hue-zone-${crypto.randomUUID()}`;
      const palette = ["--lm-zone-1", "--lm-zone-2", "--lm-zone-3", "--lm-zone-4", "--lm-zone-5", "--lm-zone-6"];
      const colorVar = `var(${palette[existing.length % palette.length]})`;
      const newZone: HueZone = {
        id,
        name: t("roomMap:hueZones.defaultName", { N: String(existing.length + 1) }),
        entertainmentAreaId: lastHueAreaId,
        centerX: 0,
        centerY: 0,
        centerZ: 0,
        scaleX: 0.5,
        scaleY: 0.5,
        scaleZ: 0.5,
        channelIndices: [],
        borderColor: colorVar,
      };
      const nextMap: RoomMapConfig = {
        ...currentMap,
        zones: [...existing, newZone],
      };
      await shellStore.save({
        roomMap: nextMap,
        roomMapVersion: (state.roomMapVersion ?? 0) + 1,
      });
      try {
        await createHueZone({ zone: newZone, existingZones: existing });
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
  // (Δ latency / Σ fps) reflects live worker state. The shared hook pauses
  // automatically when the tray window is hidden and re-arms with an
  // immediate tick on resume — nothing to do here beyond passing the
  // domain gate.
  const { snapshot: liveTelemetry } = useFullTelemetryPoll(isAmbilight, TELEMETRY_POLL_INTERVAL_MS);
  const liveUsb = liveTelemetry?.usb ?? null;

  // `usb` is non-nullable in the snapshot, so a Hue-only session still gets a
  // struct — of zeros. Reading it unconditionally painted "0ms / 0 fps" under a
  // "Signal" heading while Hue streamed fine, which reads as a dead pipeline.
  const showUsbSignal = usbSelected;
  const liveHue = liveTelemetry?.hue ?? null;

  const latencyLabel =
    showUsbSignal && liveUsb ? `${Math.round(liveUsb.frameLatencyMs)}ms` : "—";
  // Hue measures no latency, only a packet rate — so Σ carries a different unit
  // here, and the heading names the sink rather than letting the two be confused.
  const fpsLabel = showUsbSignal
    ? liveUsb
      ? `${Math.round(liveUsb.sendFps)} fps`
      : "—"
    : liveHue
      ? `${Math.round(liveHue.packetRate)} pkt/s`
      : "—";
  const signalTitle =
    !showUsbSignal && hueSelected ? t("lights:signal.titleHue") : t("lights:signal.title");

  // Gate on the flag, never on `linkMaxFps < 30` — the 0 sentinel means "no
  // serial link this session", so a raw comparison would paint every Hue-only
  // and WLED-only session as maximally constrained.
  const linkConstrained =
    liveUsb !== null && hasSerialLinkBudget(liveUsb) && liveUsb.linkConstrained;

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
        {/* Kept separate from the calibration banner: a calibrated strip that is
            merely unplugged must not be told to go and calibrate, and vice versa. */}
        {outputMissing && (
          <OnboardingBanner
            title={t("common:output.offline.title")}
            body={
              hueProbeGaveUp
                ? t("common:output.offline.stoppedBody")
                : t("common:output.offline.body")
            }
            primaryAction={
              onOpenDevices
                ? {
                    label: t("common:output.offline.action"),
                    onClick: onOpenDevices,
                  }
                : undefined
            }
            secondaryAction={
              // Still gated on `hueProbeGaveUp` — offering retry during normal
              // polling is noise. What changed is that `gaveUp` now survives a
              // manual retry, so the button no longer deletes itself on click.
              hueProbeGaveUp && onRetryHueProbe
                ? {
                    label: hueProbeChecking
                      ? t("common:output.offline.retrying")
                      : t("common:output.offline.retry"),
                    onClick: onRetryHueProbe,
                    pending: hueProbeChecking,
                  }
                : undefined
            }
          />
        )}

        {lockState.showReason && (
          <OnboardingBanner
            title={t("lights:calibrationBanner.title")}
            body={t("lights:calibrationBanner.sub")}
            primaryAction={{
              label: t("lights:calibrationBanner.action"),
              onClick: onOpenCalibration,
            }}
          />
        )}

        {/* Mode strip */}
        <div>
          <div className="lm-lights-slab">
            {t("lights:slab.modeText")} <b>{t("lights:slab.modeAccent")}</b>
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
                <span className="tn">{t("lights:mode.off.title")}</span>
                <span className="ts">{t("lights:mode.off.subtitle")}</span>
              </span>
              <ModeKeybindBadge action={KEYBIND_ACTIONS.MODE_OFF} />
            </button>
            <button
              type="button"
              className={`lm-mbtn ${isAmbilight ? "is-on" : ""}`}
              disabled={nonOffModeDisabled}
              aria-pressed={isAmbilight}
              onClick={() =>
                onModeChange({ kind: LIGHTING_MODE_KIND.AMBILIGHT, ambilight: incomingAmbilight })
              }
            >
              <span className="ico"><IconAmbilight /></span>
              <span className="tx">
                <span className="tn">{t("lights:mode.ambilight.title")}</span>
                <span className="ts">
                  {typeof totalLeds === "number" && totalLeds > 0
                    ? t("lights:mode.ambilight.subtitle", { count: totalLeds })
                    : t("lights:mode.ambilight.subtitleFallback")}
                </span>
              </span>
              <ModeKeybindBadge action={KEYBIND_ACTIONS.MODE_AMBILIGHT} />
            </button>
            <button
              type="button"
              className={`lm-mbtn ${isSolid ? "is-on" : ""}`}
              disabled={nonOffModeDisabled}
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
                <span className="tn">{t("lights:mode.solid.title")}</span>
                <span className="ts">
                  {t("lights:mode.solid.subtitle", {
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
                  ? t("lights:led.firmwareProfile.brightnessDisabledTooltip")
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
            {t("lights:slab.signalText")} <b>{t("lights:slab.signalAccent")}</b>
          </div>
          <div className="lm-signal">
            <div className="lm-signal-head">
              <span className="l">{signalTitle}</span>
              <span className="meta-pill">
                <span>
                  {t("lights:signal.delta")} <b>{latencyLabel}</b>
                </span>
                <span>
                  {t("lights:signal.fps")} <b>{fpsLabel}</b>
                </span>
              </span>
            </div>
            {/* role="status", never "alert": `linkMaxFps` is derived once at
                worker start from LED count + chip type and never re-sampled,
                so this is a steady-state condition, announced once. */}
            {linkConstrained && liveUsb ? (
              <div className="lm-signal-note" role="status">
                <span className="lm-signal-note-dot" aria-hidden />
                <span>
                  <b>
                    {t("lights:signal.linkBudget.constrained", {
                      fps: Math.round(liveUsb.linkMaxFps),
                    })}
                  </b>{" "}
                  {t("lights:signal.linkBudget.hint")}
                </span>
              </div>
            ) : null}
            <EdgeSignalGrid
              isAmbilight={isAmbilight}
              counts={counts}
              displayIndex={displayIndex}
              resolutionLabel={resolutionLabel}
            />
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
                  <span>{t("lights:signal.profile.brightness")}</span>
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
                    aria-label={t("lights:signal.profile.brightness")}
                    title={
                      isAdalight
                        ? t("lights:led.firmwareProfile.brightnessDisabledTooltip")
                        : undefined
                    }
                    onChange={(e) => handleAmbilightBrightnessChange(parseInt(e.target.value, 10))}
                  />
                </div>
              </div>
              {/* Saturation — wired to AmbilightPayload.saturation (0.5–2.0). */}
              <div className="lm-psl">
                <div className="row">
                  <span>{t("lights:signal.profile.saturation")}</span>
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
                    aria-label={t("lights:signal.profile.saturation")}
                    onChange={(e) => handleSaturationChange(parseInt(e.target.value, 10))}
                  />
                </div>
              </div>
              {/* Black border — toggle */}
              <div className="lm-psl is-toggle">
                <div className="row">
                  <span>{t("lights:signal.profile.blackBorder")}</span>
                  <b>
                    {blackBorderOn
                      ? t("lights:signal.profile.blackBorderAuto")
                      : t("lights:signal.profile.blackBorderOff")}
                  </b>
                </div>
                <div className="tr">
                  <button
                    type="button"
                    className="tr-toggle"
                    disabled={slidersDisabled}
                    aria-pressed={blackBorderOn}
                    aria-label={t("lights:signal.profile.blackBorder")}
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
            {t("lights:slab.scenesText")} <b>{t("lights:slab.scenesAccent")}</b>
          </div>
          <div className="lm-scenes">
            {SCENE_PRESETS.map((preset) => {
              const isSelected = activeScenePreset?.id === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  disabled={nonOffModeDisabled}
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
      <aside className="lm-dock" aria-label={t("lights:dock.outputs")}>
        <div>
          <h4>
            <span className="t">{t("lights:dock.outputs")}</span>
            <button
              type="button"
              className="add"
              aria-disabled={!canAddHueZone}
              aria-label={t("lights:dock.addAria")}
              title={
                canAddHueZone
                  ? t("lights:dock.addHueZoneTooltip")
                  : t("lights:dock.addDisabledTooltip")
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
                  {t("lights:dock.rows.usbName")}{" "}
                  <em>{t("lights:dock.rows.usbType")}</em>
                </div>
                <div className="s">
                  {usbConnected ? (
                    <Trans
                      i18nKey="lights:dock.rows.usbSub"
                      values={{ count: totalLeds ?? 0 }}
                      components={{ b: <b /> }}
                    />
                  ) : (
                    t("lights:dock.rows.usbSubUnavailable")
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
                  {t("lights:dock.rows.hueName")}{" "}
                  <em>{t("lights:dock.rows.hueType")}</em>
                </div>
                <div className="s">
                  {!hueAvailable ? (
                    t("lights:dock.rows.hueSubUnavailable")
                  ) : hueStreaming ? (
                    <Trans
                      i18nKey="lights:dock.rows.hueSubStreaming"
                      components={{ b: <b /> }}
                    />
                  ) : (
                    <Trans
                      i18nKey="lights:dock.rows.hueSubIdle"
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
          <b>{t("lights:dock.hintTitle")}</b>
          {t("lights:dock.hintBody")
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
