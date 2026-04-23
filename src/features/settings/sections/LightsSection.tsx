import { useEffect, useMemo, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
import type { HueRuntimeTarget } from "../../../shared/contracts/hue";
import type { DisplayInfo } from "../../../shared/contracts/display";
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

import { SolidColorPanel } from "./control/SolidColorPanel";

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

  // Slider handlers.
  const handleSmoothingChange = (value: number) => {
    onModeChange({
      kind: LIGHTING_MODE_KIND.AMBILIGHT,
      ambilight: { ...incomingAmbilight, smoothingAlpha: value },
    });
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

  const smoothingValue = incomingAmbilight.smoothingAlpha ?? 0.35;
  const smoothingPercent = Math.round(((smoothingValue - 0.05) / 0.95) * 100);
  const saturationValue = Math.round((incomingAmbilight.saturation ?? 1) * 100);
  const saturationFillPercent = Math.round(((saturationValue - 50) / 150) * 100);
  const blackBorderOn = incomingAmbilight.blackBorderDetection ?? false;

  const slidersDisabled = !isAmbilight || modeSelectorDisabled;

  return (
    <div className="lm-lights-page">
      {/* ── Center column ─────────────────────────────────────────────── */}
      <div className="lm-lights-center">
        {lockState.showReason && (
          <div className="lm-lights-cal-banner">
            <div>
              <div className="ttl">{t("lightsPage.calibrationBanner.title")}</div>
              <div className="sub">{t("lightsPage.calibrationBanner.sub")}</div>
            </div>
            <button type="button" className="act" onClick={onOpenCalibration}>
              {t("lightsPage.calibrationBanner.action")}
            </button>
          </div>
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
            <div className="lm-profile">
              {/* Smoothing — wired */}
              <div className="lm-psl">
                <div className="row">
                  <span>{t("lightsPage.signal.profile.smoothing")}</span>
                  <b>{smoothingValue.toFixed(2)}</b>
                </div>
                <div className="tr">
                  <div className="tr-track">
                    <span className="tr-fill" style={{ width: `${smoothingPercent}%` }} />
                  </div>
                  <input
                    type="range"
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={smoothingValue}
                    disabled={slidersDisabled}
                    aria-label={t("lightsPage.signal.profile.smoothing")}
                    onChange={(e) => handleSmoothingChange(parseFloat(e.target.value))}
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
      </div>

      {/* ── Right dock ────────────────────────────────────────────────── */}
      <aside className="lm-dock" aria-label={t("lightsPage.dock.outputs")}>
        <div>
          <h4>
            <span className="t">{t("lightsPage.dock.outputs")}</span>
            <button
              type="button"
              className="add"
              disabled
              aria-disabled="true"
              aria-label={t("lightsPage.dock.addAria")}
              title={t("lightsPage.dock.addTooltip")}
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
