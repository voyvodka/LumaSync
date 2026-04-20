/**
 * CompactLayout — tray-style compact UI (UI Mockup Rev 07 — `10-compact.html`).
 *
 * Stacked column inside a 320-wide window:
 *   1. Mode strip   — Off / Ambilight / Solid pills (amber glow on active)
 *   2. Active card  — header + mode-specific controls (hidden for Off)
 *   3. Scene row    — 5 mood tiles with gradient thumbnails
 *
 * Status pills (USB / HUE / mode summary / version) live in the global
 * StatusBar (`src/features/shell/StatusBar.tsx`), so this layout no
 * longer renders its own footer.
 *
 * Reuses the existing `onLightingModeChange` flow so backend wiring,
 * mode guards, and persistence stay consistent with the full layout.
 * Brightness commits are throttled to 20 Hz inside
 * `SelfContainedBrightnessRow` to keep the Hue bridge happy and avoid
 * cascading reconciliations during a drag.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LIGHTING_MODE_KIND,
  type LightingModeConfig,
  type LightingModeKind,
} from "../../../mode/model/contracts";
import {
  MODE_GUARD_REASONS,
  type ModeGuardReason,
} from "../../../mode/state/modeGuard";
import type { HueRuntimeTarget } from "../../../../shared/contracts/hue";
import { SCENE_PRESETS, type ScenePreset } from "../../../mode/model/scenePresets";

interface CompactLayoutProps {
  lightingMode: LightingModeConfig;
  outputTargets: HueRuntimeTarget[];
  usbConnected: boolean;
  hueConfigured: boolean;
  hueReachable: boolean;
  isModeTransitioning: boolean;
  modeLockReason: ModeGuardReason | null;
  onLightingModeChange: (next: LightingModeConfig) => void;
}

const DEFAULT_SOLID = { r: 255, g: 220, b: 180, brightness: 1 } as const;
const DEFAULT_AMBILIGHT = {
  brightness: 1,
  smoothingAlpha: 0.35,
  blackBorderDetection: false,
} as const;

export function CompactLayout({
  lightingMode,
  outputTargets,
  usbConnected,
  hueConfigured,
  hueReachable,
  isModeTransitioning,
  modeLockReason,
  onLightingModeChange,
}: CompactLayoutProps) {
  const { t } = useTranslation("common");

  const incomingSolid = lightingMode.solid ?? DEFAULT_SOLID;
  const ambilightConfig = lightingMode.ambilight ?? DEFAULT_AMBILIGHT;
  const isOff = lightingMode.kind === LIGHTING_MODE_KIND.OFF;
  const isSolid = lightingMode.kind === LIGHTING_MODE_KIND.SOLID;
  const isAmbilight = lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT;

  // Gate non-Off modes behind "at least one output is actually reachable".
  // Without this, Ambilight happily transitions into a running state even
  // when no USB/Hue target is connected — the worker spins up but has
  // nowhere to send frames.
  const hasAnyOutput = usbConnected || (hueConfigured && hueReachable);
  const activationBlocked = !hasAnyOutput;
  const calibrationLocked = modeLockReason === MODE_GUARD_REASONS.CALIBRATION_REQUIRED;
  const nonOffDisabled = isModeTransitioning || activationBlocked || calibrationLocked;

  const handleModeClick = useCallback(
    (kind: LightingModeKind) => {
      if (kind === LIGHTING_MODE_KIND.OFF) {
        onLightingModeChange({ kind: LIGHTING_MODE_KIND.OFF });
        return;
      }
      if (kind === LIGHTING_MODE_KIND.AMBILIGHT) {
        onLightingModeChange({
          kind: LIGHTING_MODE_KIND.AMBILIGHT,
          ambilight: ambilightConfig,
        });
        return;
      }
      onLightingModeChange({
        kind: LIGHTING_MODE_KIND.SOLID,
        solid: incomingSolid,
        targets: outputTargets,
      });
    },
    [ambilightConfig, incomingSolid, outputTargets, onLightingModeChange],
  );

  const handleAmbilightBrightnessCommit = useCallback(
    (next: number) => {
      onLightingModeChange({
        kind: LIGHTING_MODE_KIND.AMBILIGHT,
        ambilight: { ...ambilightConfig, brightness: next },
      });
    },
    [ambilightConfig, onLightingModeChange],
  );

  const handleSolidCommit = useCallback(
    (payload: { r: number; g: number; b: number; brightness: number }) => {
      onLightingModeChange({
        kind: LIGHTING_MODE_KIND.SOLID,
        solid: payload,
        targets: outputTargets,
      });
    },
    [outputTargets, onLightingModeChange],
  );

  // Click → SOLID mode with the preset RGB. When we're already in SOLID
  // the user's current brightness is preserved so manual tweaks survive;
  // otherwise the preset's own brightness is used so a fresh scene hits
  // the intended mood on entry.
  const handleScenePresetClick = useCallback(
    (preset: ScenePreset) => {
      onLightingModeChange({
        kind: LIGHTING_MODE_KIND.SOLID,
        solid: {
          r: preset.r,
          g: preset.g,
          b: preset.b,
          brightness: isSolid ? incomingSolid.brightness : preset.brightness,
        },
        targets: outputTargets,
      });
    },
    [isSolid, incomingSolid.brightness, outputTargets, onLightingModeChange],
  );

  const ambilightBrightnessPct = Math.round(ambilightConfig.brightness * 100);

  return (
    <div className="lm-compact">
      <div className="lm-compact-body">
        {/* ── Mode strip ─────────────────────────────────────────── */}
        <div>
          <div className="lm-compact-section-title">{t("general.compact.sections.mode")}</div>
          <div className="lm-compact-mode-strip">
            <ModeButton
              kind={LIGHTING_MODE_KIND.OFF}
              active={isOff}
              disabled={isModeTransitioning}
              label={t("general.mode.options.off")}
              icon={<IconOff />}
              onClick={handleModeClick}
            />
            <ModeButton
              kind={LIGHTING_MODE_KIND.AMBILIGHT}
              active={isAmbilight}
              disabled={nonOffDisabled}
              label={t("general.mode.options.ambilight")}
              icon={<IconAmbilight />}
              onClick={handleModeClick}
            />
            <ModeButton
              kind={LIGHTING_MODE_KIND.SOLID}
              active={isSolid}
              disabled={nonOffDisabled}
              label={t("general.mode.options.solid")}
              icon={<IconSolid />}
              onClick={handleModeClick}
            />
          </div>
        </div>

        {/* ── Active mode card ──────────────────────────────────── */}
        {isAmbilight && (
          <div className="lm-compact-card">
            <div className="lm-compact-card-header">
              <div className="l">{t("general.mode.options.ambilight")}</div>
            </div>
            <SelfContainedBrightnessRow
              initialPercent={ambilightBrightnessPct}
              disabled={nonOffDisabled}
              onCommit={handleAmbilightBrightnessCommit}
            />
          </div>
        )}

        {isSolid && (
          <CompactSolidSection
            incoming={incomingSolid}
            disabled={nonOffDisabled}
            onCommit={handleSolidCommit}
            label={t("general.mode.options.solid")}
            sublabel={t("general.mode.solidColor")}
          />
        )}

        {/* ── Scene presets ──────────────────────────────────────── */}
        <div>
          <div className="lm-compact-section-title">
            {t("general.compact.sections.scene")}
          </div>
          <div className="lm-compact-scenes">
            {SCENE_PRESETS.map((preset) => {
              const isSelected =
                isSolid &&
                incomingSolid.r === preset.r &&
                incomingSolid.g === preset.g &&
                incomingSolid.b === preset.b;
              return (
                <button
                  key={preset.id}
                  type="button"
                  disabled={nonOffDisabled}
                  onClick={() => handleScenePresetClick(preset)}
                  className={`lm-compact-scene-tile ${isSelected ? "is-selected" : ""}`}
                  style={{ background: preset.gradient }}
                  title={t(preset.labelKey)}
                >
                  <span>{t(preset.labelKey)}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// ModeButton — single mbtn pill
// ────────────────────────────────────────────────────────────────

interface ModeButtonProps {
  kind: LightingModeKind;
  active: boolean;
  disabled: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: (kind: LightingModeKind) => void;
}

function ModeButton({ kind, active, disabled, label, icon, onClick }: ModeButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onClick(kind)}
      className={`lm-compact-mbtn ${active ? "is-on" : ""}`}
      aria-pressed={active}
    >
      <span className="ico">{icon}</span>
      <span className="tn">{label}</span>
    </button>
  );
}

function IconOff() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="9" />
      <line x1="5" y1="5" x2="19" y2="19" />
    </svg>
  );
}

function IconAmbilight() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="5.5" width="18" height="12" rx="1.5" />
      <path d="M2 9l2-2M22 9l-2-2M2 14l2 2M22 14l-2 2" />
    </svg>
  );
}

function IconSolid() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
    </svg>
  );
}

// ────────────────────────────────────────────────────────────────
// CompactSolidSection — Solid mode card (hero color tile + slider)
// ────────────────────────────────────────────────────────────────
//
// IMPORTANT — why the solid draft lives in this child, not in
// CompactLayout: hoisting it caused every brightness pointer tick to
// reconcile the mode strip, scene row and card together. Pushing
// ownership down isolates re-renders to the slider itself (the
// throttled commit only fires at 20 Hz, mirroring the full-mode
// pattern).

const BRIGHTNESS_COMMIT_MIN_INTERVAL_MS = 50;

interface CompactSolidSectionProps {
  incoming: { r: number; g: number; b: number; brightness: number };
  disabled: boolean;
  label: string;
  sublabel: string;
  onCommit: (payload: { r: number; g: number; b: number; brightness: number }) => void;
}

function CompactSolidSection({
  incoming,
  disabled,
  label,
  sublabel,
  onCommit,
}: CompactSolidSectionProps) {
  const incomingRef = useRef(incoming);
  useEffect(() => {
    incomingRef.current = incoming;
  }, [incoming]);

  const handleBrightnessCommit = useCallback(
    (nextUnit: number) => {
      const current = incomingRef.current;
      onCommit({ r: current.r, g: current.g, b: current.b, brightness: nextUnit });
    },
    [onCommit],
  );

  const handleColorChange = useCallback(
    (hex: string) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const current = incomingRef.current;
      onCommit({ r, g, b, brightness: current.brightness });
    },
    [onCommit],
  );

  const brightnessPct = Math.round(incoming.brightness * 100);

  return (
    <div className="lm-compact-card">
      <div className="lm-compact-card-header">
        <div className="l">{label}</div>
      </div>
      <HeroColorCard
        rgb={incoming}
        disabled={disabled}
        sublabel={sublabel}
        onChange={handleColorChange}
      />
      <SelfContainedBrightnessRow
        initialPercent={brightnessPct}
        disabled={disabled}
        onCommit={handleBrightnessCommit}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// HeroColorCard — full-width tile that opens the native color picker
// ────────────────────────────────────────────────────────────────

interface HeroColorCardProps {
  rgb: { r: number; g: number; b: number };
  disabled: boolean;
  sublabel: string;
  onChange: (hex: string) => void;
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Rec. 709 relative luminance — picks black or white text against tile bg. */
function perceivedLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function HeroColorCard({ rgb, disabled, sublabel, onChange }: HeroColorCardProps) {
  const { t } = useTranslation("common");
  const hex = rgbToHex(rgb);
  const isLight = perceivedLuminance(rgb) > 0.62;
  const textColor = isLight ? "rgba(0,0,0,0.82)" : "rgba(255,255,255,0.92)";
  const subTextColor = isLight ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.65)";
  const edgeColor = isLight ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.18)";
  const eyeBg = isLight ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.28)";

  return (
    <label
      className={`lm-compact-hero ${disabled ? "is-disabled" : ""}`}
      aria-label={t("general.mode.solidColor")}
      style={{
        background: hex,
        backgroundImage:
          "linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 55%, rgba(0,0,0,0.08) 100%)",
        boxShadow: `0 8px 24px -8px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.55), inset 0 0 0 1px ${edgeColor}`,
      }}
    >
      <span className="lm-compact-hero-text">
        <span className="lm-compact-hero-hex" style={{ color: textColor }}>
          {hex.toUpperCase()}
        </span>
        <span className="lm-compact-hero-sub" style={{ color: subTextColor }}>
          {sublabel}
        </span>
      </span>
      <span
        aria-hidden
        className="lm-compact-hero-eye"
        style={{ background: eyeBg, color: textColor }}
      >
        <EyedropperIcon />
      </span>
      <input
        type="color"
        value={hex}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t("general.mode.solidColor")}
        className="lm-compact-hero-input"
      />
    </label>
  );
}

function EyedropperIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 2.5l3.5 3.5-7 7H3v-3.5l7-7z" />
      <path d="M9 3.5l3.5 3.5" />
    </svg>
  );
}

// ────────────────────────────────────────────────────────────────
// SelfContainedBrightnessRow — throttled <input type=range>
// ────────────────────────────────────────────────────────────────
//
// Owns its own visible percentage in local state and only notifies the
// parent through a 20 Hz throttled `onCommit`. `initialPercent` seeds
// the state and re-syncs when the external value drifts (mode switch,
// scene click) but ONLY while the user is not dragging — a pointer
// guard prevents echo commits from snapping the thumb mid-drag.

interface SelfContainedBrightnessRowProps {
  initialPercent: number;
  disabled: boolean;
  onCommit: (next: number) => void;
}

function SelfContainedBrightnessRow({
  initialPercent,
  disabled,
  onCommit,
}: SelfContainedBrightnessRowProps) {
  const { t } = useTranslation("common");
  const [localPercent, setLocalPercent] = useState(initialPercent);
  const isDraggingRef = useRef(false);

  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const pendingPercentRef = useRef(initialPercent);
  const throttleRef = useRef<{ timer: number | null; lastAt: number }>({
    timer: null,
    lastAt: 0,
  });

  useEffect(() => {
    return () => {
      if (throttleRef.current.timer !== null) {
        window.clearTimeout(throttleRef.current.timer);
        throttleRef.current.timer = null;
      }
    };
  }, []);

  useEffect(() => {
    if (isDraggingRef.current) return;
    setLocalPercent(initialPercent);
    pendingPercentRef.current = initialPercent;
  }, [initialPercent]);

  const flushCommit = useCallback(() => {
    throttleRef.current.lastAt = Date.now();
    throttleRef.current.timer = null;
    onCommitRef.current(pendingPercentRef.current / 100);
  }, []);

  const scheduleCommit = useCallback(
    (nextPercent: number) => {
      pendingPercentRef.current = nextPercent;
      const now = Date.now();
      const elapsed = now - throttleRef.current.lastAt;
      const waitMs = Math.max(0, BRIGHTNESS_COMMIT_MIN_INTERVAL_MS - elapsed);
      if (throttleRef.current.timer !== null) {
        window.clearTimeout(throttleRef.current.timer);
        throttleRef.current.timer = null;
      }
      if (waitMs === 0) {
        flushCommit();
      } else {
        throttleRef.current.timer = window.setTimeout(flushCommit, waitMs);
      }
    },
    [flushCommit],
  );

  const handlePointerEnd = useCallback(() => {
    isDraggingRef.current = false;
    if (throttleRef.current.timer !== null) {
      window.clearTimeout(throttleRef.current.timer);
      throttleRef.current.timer = null;
    }
    flushCommit();
  }, [flushCommit]);

  // CSS variable drives the `linear-gradient` stop in `.lm-compact-slider`'s
  // track pseudo-element so the amber fill grows live with the thumb.
  const sliderStyle = { ["--lm-fill" as string]: `${localPercent}%` } as React.CSSProperties;

  return (
    <div className="lm-compact-slider-row">
      <div className="srow">
        <span>{t("general.mode.brightness")}</span>
        <b>{localPercent}%</b>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={localPercent}
        disabled={disabled}
        className="lm-compact-slider"
        style={sliderStyle}
        onPointerDown={() => {
          isDraggingRef.current = true;
        }}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onChange={(e) => {
          const next = Number(e.target.value);
          setLocalPercent(next);
          scheduleCommit(next);
        }}
      />
    </div>
  );
}
