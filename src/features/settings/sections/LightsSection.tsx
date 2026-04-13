import { useState } from "react";
import { useTranslation, Trans } from "react-i18next";

import {
  MODE_GUARD_REASONS,
  type ModeGuardReason,
} from "../../mode/state/modeGuard";
import {
  LIGHTING_MODE_KIND,
  normalizeLightingModeConfig,
  normalizeAmbilightPayload,
  type LightingModeConfig,
} from "../../mode/model/contracts";
import type { HueRuntimeTarget } from "../../../shared/contracts/hue";
import type { LedCalibrationConfig } from "../../calibration/model/contracts";

import { SolidColorPanel } from "./control/SolidColorPanel";

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

// Scene presets — visual-only for now. Gradients match mockup 06.
const SCENE_PRESETS = [
  { id: "movie", gradient: "linear-gradient(135deg,#2a1235,#6a1c50,#d9521e,#ffb030)" },
  { id: "game", gradient: "linear-gradient(135deg,#0a1838,#1e4878,#66b4ff,#a8e0ff)" },
  { id: "music", gradient: "linear-gradient(135deg,#1a0a22,#3e1858,#a03878,#ff6a88)" },
  { id: "chill", gradient: "linear-gradient(135deg,#1a1305,#4e3010,#d9821e,#ffc860)" },
  { id: "reading", gradient: "linear-gradient(135deg,#0a1a0a,#1e4428,#4cad70,#a8e0b4)" },
] as const;

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

  // Visual-only scene state — no backend binding yet.
  const [selectedScene, setSelectedScene] = useState<string | null>(null);

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

  // Placeholder: saturation is not in AmbilightPayload yet.
  const [saturationPlaceholder, setSaturationPlaceholder] = useState(118);

  // Real LED counts from calibration when available — fall back to mockup
  // defaults so the page still renders before first calibration.
  const totalLeds = calibration?.totalLeds;
  const edgeCounts = calibration?.counts;
  const topCount = edgeCounts?.top ?? 24;
  const botCount = edgeCounts?.bottom ?? 24;
  const leftCount = edgeCounts?.left ?? 18;
  const rightCount = edgeCounts?.right ?? 18;

  const smoothingValue = incomingAmbilight.smoothingAlpha ?? 0.35;
  const smoothingPercent = Math.round(((smoothingValue - 0.05) / 0.95) * 100);
  const saturationPercent = Math.round(((saturationPlaceholder - 50) / 150) * 100);
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
              <span className="kb">⌥1</span>
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
              <span className="kb">⌥2</span>
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
              <span className="kb">⌥3</span>
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

        {/* Edge signal + profile */}
        <div>
          <div className="lm-lights-slab">
            {t("lightsPage.slab.signalText")} <b>{t("lightsPage.slab.signalAccent")}</b>
          </div>
          <div className="lm-signal">
            <div className="lm-signal-head">
              <span className="l">{t("lightsPage.signal.title")}</span>
              <span className="meta-pill">
                <span>
                  {t("lightsPage.signal.delta")} <b>{t("lightsPage.signal.placeholderLatency")}</b>
                </span>
                <span>
                  {t("lightsPage.signal.fps")} <b>{t("lightsPage.signal.placeholderFps")}</b>
                </span>
              </span>
            </div>
            <div className="lm-edges">
              <div className="lm-edge lm-edge-top">
                <span className="label">{t("lightsPage.signal.edges.top", { count: topCount })}</span>
              </div>
              <div className="lm-edge lm-edge-l">
                <span className="label">{t("lightsPage.signal.edges.left", { count: leftCount })}</span>
              </div>
              <div className="lm-edge lm-edge-c">
                <div className="scene">
                  <b>{t("lightsPage.signal.display.label")}</b>
                  {t("lightsPage.signal.display.sub")}
                </div>
              </div>
              <div className="lm-edge lm-edge-r">
                <span className="label">{t("lightsPage.signal.edges.right", { count: rightCount })}</span>
              </div>
              <div className="lm-edge lm-edge-bot">
                <span className="label">{t("lightsPage.signal.edges.bot", { count: botCount })}</span>
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
              {/* Saturation — visual-only placeholder */}
              <div className="lm-psl">
                <div className="row">
                  <span>{t("lightsPage.signal.profile.saturation")}</span>
                  <b>{saturationPlaceholder}%</b>
                </div>
                <div className="tr">
                  <div className="tr-track">
                    <span className="tr-fill" style={{ width: `${saturationPercent}%` }} />
                  </div>
                  <input
                    type="range"
                    min={50}
                    max={200}
                    step={1}
                    value={saturationPlaceholder}
                    disabled={slidersDisabled}
                    aria-label={t("lightsPage.signal.profile.saturation")}
                    onChange={(e) => setSaturationPlaceholder(parseInt(e.target.value, 10))}
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
        </div>

        {/* Scene presets — visual placeholder */}
        <div>
          <div className="lm-lights-slab">
            {t("lightsPage.slab.scenesText")} <b>{t("lightsPage.slab.scenesAccent")}</b>
          </div>
          <div className="lm-scenes">
            {SCENE_PRESETS.map((preset) => {
              const isSelected = selectedScene === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`lm-sc ${isSelected ? "is-sel" : ""}`}
                  style={{ background: preset.gradient }}
                  onClick={() => setSelectedScene(isSelected ? null : preset.id)}
                >
                  <b>{t(`lightsPage.scenes.${preset.id}`)}</b>
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
            <button type="button" className="add" aria-label={t("lightsPage.dock.addAria")}>
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
