/**
 * CompactLayout — tray-style compact UI for the main window.
 *
 * Stacked column inside a 320-wide window:
 *   1. Header     — app name + maximize button
 *   2. Mode row   — Off / Ambilight / Solid
 *   3. Mode panel — hidden for Off; shows mode-specific controls for
 *                   Solid (color picker + brightness) and Ambilight
 *                   (brightness). Renders nothing when it has no content so
 *                   we never waste vertical space on filler text.
 *   4. Presets    — 6 static color tiles
 *   5. Footer     — USB / Hue status dots
 *
 * Reuses the existing `onLightingModeChange` flow so backend wiring, mode
 * guards, and persistence stay consistent with the full layout.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LIGHTING_MODE_KIND,
  type LightingModeConfig,
} from "../../../mode/model/contracts";
import type { HueRuntimeTarget } from "../../../../shared/contracts/hue";
import { ModeSelectorRow } from "../control/ModeSelectorRow";
import { COMPACT_PRESETS, type CompactPreset } from "./COMPACT_PRESETS";
import { useAccentTheme } from "../../../shell/useAccentTheme";

interface CompactLayoutProps {
  lightingMode: LightingModeConfig;
  outputTargets: HueRuntimeTarget[];
  usbConnected: boolean;
  hueConfigured: boolean;
  hueReachable: boolean;
  hueStreaming: boolean;
  isModeTransitioning: boolean;
  onLightingModeChange: (next: LightingModeConfig) => void;
}

const DEFAULT_SOLID = { r: 255, g: 220, b: 180, brightness: 1 } as const;
const DEFAULT_AMBILIGHT = { brightness: 1, smoothingAlpha: 0.35, blackBorderDetection: false } as const;

export function CompactLayout({
  lightingMode,
  outputTargets,
  usbConnected,
  hueConfigured,
  hueReachable,
  hueStreaming,
  isModeTransitioning,
  onLightingModeChange,
}: CompactLayoutProps) {
  const { t } = useTranslation("common");

  const incomingSolid = lightingMode.solid ?? DEFAULT_SOLID;
  const ambilightConfig = lightingMode.ambilight ?? DEFAULT_AMBILIGHT;
  const isSolid = lightingMode.kind === LIGHTING_MODE_KIND.SOLID;
  const isAmbilight = lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT;

  // Gate non-Off modes behind "at least one output is actually reachable".
  // Without this, Ambilight happily transitions into a running state even
  // when no USB/Hue target is connected — the screen capture worker spins
  // up but has nowhere to send frames. Off stays enabled so the user can
  // always return to a safe state.
  const hasAnyOutput = usbConnected || (hueConfigured && hueReachable);
  const activationBlocked = !hasAnyOutput;

  // IMPORTANT — why the solid draft lives in the child section, not here.
  //
  // Full mode keeps its useSolidColorDraft inside `SolidColorPanel`, so
  // dragging the brightness slider only re-renders that panel. In compact
  // mode we used to hoist the draft up to CompactLayout, which meant every
  // pointer tick reconciled the mode-selector row, the hero color card,
  // the preset grid, and the footer — all just to update a single slider.
  // That reconciliation cost is what made the compact brightness slider
  // feel "sticky" while the full-mode slider was buttery.
  //
  // The fix: push ownership of the draft into `CompactSolidSection` so it
  // mirrors the full-mode pattern exactly. CompactLayout now only knows
  // about the committed `lightingMode` prop, which updates at most once
  // per 50ms commit — the wash, mode buttons, and presets retint at that
  // rate, which is imperceptible for discrete actions (preset click,
  // color-picker dialog close) and irrelevant for brightness (r/g/b don't
  // change during a brightness drag anyway).
  const accentTheme = useAccentTheme(lightingMode);

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

  // Brightness reference used when the user clicks a preset from a state
  // that isn't SOLID yet — we want to preserve the last SOLID brightness
  // instead of always snapping to 100%. Committed `lightingMode.solid`
  // already reflects this because presets flush immediately, so we read
  // from it directly.
  const handlePresetClick = useCallback(
    (preset: CompactPreset) => {
      onLightingModeChange({
        kind: LIGHTING_MODE_KIND.SOLID,
        solid: {
          r: preset.r,
          g: preset.g,
          b: preset.b,
          brightness: isSolid ? incomingSolid.brightness : 1,
        },
        targets: outputTargets,
      });
    },
    [isSolid, incomingSolid.brightness, outputTargets, onLightingModeChange],
  );

  const ambilightBrightnessPct = Math.round(ambilightConfig.brightness * 100);

  return (
    <div
      className="relative flex h-full w-full flex-col overflow-hidden bg-slate-100/60 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100"
      style={{
        // Layered backgrounds: accent wash flows from the top of the window
        // down past the mode selector AND the color card. We use the
        // resolved gradient string (not `var(--accent-gradient)`) so React
        // mutates the DOM style on every render — otherwise backdrop-filter
        // layers below don't re-composite and the tint lags the draft.
        backgroundImage: accentTheme.gradient ?? "none",
        backgroundRepeat: "no-repeat",
        backgroundSize: "100% 320px",
      }}
    >
      {/* ── Scrollable body ────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="space-y-4">
          {/* ── Mode selector (compact) ───────────────────────────── */}
          <section>
            <ModeSelectorRow
              compact
              activeKind={lightingMode.kind}
              disabled={isModeTransitioning}
              disableNonOffModes={activationBlocked}
              ambilightConfig={ambilightConfig}
              solidDraft={incomingSolid}
              onModeChange={onLightingModeChange}
              accentColor={accentTheme.color}
            />
          </section>

          {/* ── Mode-specific controls ────────────────────────────
               Rendered only when the active mode has controls worth
               showing. Off → nothing (no filler text). Each section
               owns its own draft/local state so brightness drags stay
               isolated inside the section and don't trigger a full
               CompactLayout reconciliation every pointer tick. */}
          {isSolid && (
            <CompactSolidSection
              incoming={incomingSolid}
              disabled={isModeTransitioning || activationBlocked}
              accentColor={accentTheme.color}
              onCommit={handleSolidCommit}
            />
          )}

          {isAmbilight && (
            <section className="space-y-3 rounded-xl border border-slate-200/70 bg-white/50 px-3 py-3 dark:border-zinc-800/70 dark:bg-zinc-900/40">
              <SelfContainedBrightnessRow
                initialPercent={ambilightBrightnessPct}
                disabled={isModeTransitioning || activationBlocked}
                accentColor={accentTheme.color}
                onCommit={handleAmbilightBrightnessCommit}
              />
            </section>
          )}

          {/* ── Preset grid ───────────────────────────────────────── */}
          <section>
            <div className="mb-1.5">
              <span className="text-[10px] font-semibold tracking-wide uppercase text-slate-500 dark:text-zinc-400">
                {t("general.compact.presets")}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {COMPACT_PRESETS.map((preset) => {
                const presetHex = `rgb(${preset.r}, ${preset.g}, ${preset.b})`;
                const presetLabel = t(preset.labelKey);
                const isActive =
                  lightingMode.kind === LIGHTING_MODE_KIND.SOLID &&
                  incomingSolid.r === preset.r &&
                  incomingSolid.g === preset.g &&
                  incomingSolid.b === preset.b;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={isModeTransitioning || activationBlocked}
                    onClick={() => handlePresetClick(preset)}
                    className={`group flex flex-col items-center gap-1 rounded-lg border-2 p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      isActive
                        ? "border-transparent bg-white/70 shadow-sm dark:bg-zinc-900/55"
                        : "border-slate-200/70 bg-white/35 hover:border-slate-300 hover:bg-white/55 dark:border-zinc-800/70 dark:bg-zinc-900/30 dark:hover:border-zinc-700 dark:hover:bg-zinc-900/50"
                    }`}
                    style={
                      isActive
                        ? { borderColor: accentTheme.color }
                        : undefined
                    }
                    title={presetLabel}
                  >
                    <div
                      className="h-7 w-full rounded border border-slate-200/60 dark:border-zinc-700/60"
                      style={{ background: presetHex }}
                    />
                    <span className="text-[9px] font-medium text-slate-500 dark:text-zinc-400">
                      {presetLabel}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>

      {/* ── Footer status dots ──────────────────────────────────────── */}
      <footer className="flex items-center justify-between border-t border-slate-200/70 px-4 py-2 dark:border-zinc-800">
        <StatusDot
          label={t("general.compact.targets.usb")}
          active={usbConnected && outputTargets.includes("usb")}
          available={usbConnected}
        />
        <StatusDot
          label={t("general.compact.targets.hue")}
          active={hueStreaming}
          available={hueConfigured && hueReachable}
        />
      </footer>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// HeroColorCard
// ────────────────────────────────────────────────────────────────
//
// Full-width tile whose background IS the currently selected color. The
// hex value sits on top in a contrast-aware tone (white text on dark
// colors, black on light colors, chosen via perceived luminance). The
// entire tile is a `<label>` wrapping a visually hidden
// `<input type="color">`, so a click anywhere on the card opens the
// native picker. A soft drop shadow tinted with the color creates an
// ambient "light pool" around the card that matches the global accent
// wash flowing from the top of the compact layout.

interface HeroColorCardProps {
  rgb: { r: number; g: number; b: number };
  disabled: boolean;
  onChange: (hex: string) => void;
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Rec. 709 relative luminance. Used to decide whether the hex label on
 * top of the color tile should be rendered in black or white so it stays
 * legible against any user-chosen color.
 */
function perceivedLuminance({
  r,
  g,
  b,
}: {
  r: number;
  g: number;
  b: number;
}): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function HeroColorCard({ rgb, disabled, onChange }: HeroColorCardProps) {
  const { t } = useTranslation("common");
  const hex = rgbToHex(rgb);
  const isLight = perceivedLuminance(rgb) > 0.62;

  const textColor = isLight ? "rgba(0,0,0,0.82)" : "rgba(255,255,255,0.92)";
  const subTextColor = isLight ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.65)";
  const edgeColor = isLight ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.18)";

  return (
    <div
      aria-label={t("general.mode.solidColor")}
      className={`relative flex h-16 w-full items-center justify-between overflow-hidden rounded-xl px-4 transition-transform ${
        disabled
          ? "cursor-not-allowed opacity-50"
          : "active:scale-[0.985]"
      }`}
      style={{
        background: hex,
        // Subtle top sheen + ambient tinted drop shadow so the tile feels
        // like it is emitting light rather than just painted.
        backgroundImage:
          "linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 55%, rgba(0,0,0,0.08) 100%)",
        boxShadow: `0 8px 24px -8px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.55), inset 0 0 0 1px ${edgeColor}`,
      }}
    >
      <div
        className="flex flex-col items-start leading-none"
        style={{ pointerEvents: "none" }}
      >
        <span
          className="font-mono text-[16px] font-semibold tracking-wider tabular-nums"
          style={{ color: textColor }}
        >
          {hex.toUpperCase()}
        </span>
        <span
          className="mt-1 text-[9px] font-medium tracking-[0.12em] uppercase"
          style={{ color: subTextColor }}
        >
          {t("general.mode.solidColor")}
        </span>
      </div>

      <span
        aria-hidden
        className="flex h-7 w-7 items-center justify-center rounded-full backdrop-blur-sm"
        style={{
          background: isLight ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.28)",
          color: textColor,
          pointerEvents: "none",
        }}
      >
        <EyedropperIcon />
      </span>

      {/* Native color input laid over the whole card so the macOS
          picker anchors to the card's position instead of falling back
          to the window's bottom-left (which is what happens when the
          input is moved off-screen via sr-only). Decorative children
          are pointer-events:none so they never intercept the click. */}
      <input
        id="compact-solid-color"
        type="color"
        value={hex}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t("general.mode.solidColor")}
        className={`absolute inset-0 h-full w-full opacity-0 ${
          disabled ? "cursor-not-allowed" : "cursor-pointer"
        }`}
      />
    </div>
  );
}

function EyedropperIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
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
// BrightnessRow
// ────────────────────────────────────────────────────────────────
//
// Slider whose track is a live gradient from a near-black base to the
// current accent color. Unlike a neutral grey track with an accent
// highlight, this communicates "brightness = how close to the full color
// you are" visually. The thumb is a custom white circle with an accent
// ring so it reads as a light source sliding along the gradient.

// ────────────────────────────────────────────────────────────────
// CompactSolidSection
// ────────────────────────────────────────────────────────────────
//
// Wraps the solid-mode controls (hero color card + brightness slider).
// Brightness throttling lives inside SelfContainedBrightnessRow itself
// so both ambilight and solid compact modes get the same 20 Hz commit
// rate without each caller re-implementing the scheduler.

const BRIGHTNESS_COMMIT_MIN_INTERVAL_MS = 50;

interface CompactSolidSectionProps {
  incoming: { r: number; g: number; b: number; brightness: number };
  disabled: boolean;
  accentColor: string;
  onCommit: (payload: { r: number; g: number; b: number; brightness: number }) => void;
}

function CompactSolidSection({
  incoming,
  disabled,
  accentColor,
  onCommit,
}: CompactSolidSectionProps) {
  // Incoming mirror — kept in refs so closures always read the latest
  // values without having to depend on them and re-create callbacks on
  // every render.
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
    <section className="space-y-3 rounded-xl border border-slate-200/70 bg-white/50 px-3 py-3 dark:border-zinc-800/70 dark:bg-zinc-900/40">
      <HeroColorCard rgb={incoming} disabled={disabled} onChange={handleColorChange} />
      <SelfContainedBrightnessRow
        initialPercent={brightnessPct}
        disabled={disabled}
        accentColor={accentColor}
        onCommit={handleBrightnessCommit}
      />
    </section>
  );
}

// ────────────────────────────────────────────────────────────────
// SelfContainedBrightnessRow
// ────────────────────────────────────────────────────────────────
//
// A <input type=range> wrapper that owns its own visible percentage
// in local state and only notifies the parent through `onCommit`.
// `initialPercent` seeds the state and re-syncs when the external
// value drifts away (e.g. on mode switch or preset click) but ONLY
// while the user is not actively interacting — a `pointerdown` /
// `pointerup` guard prevents echo commits from snapping the thumb
// back mid-drag.

interface SelfContainedBrightnessRowProps {
  initialPercent: number;
  disabled: boolean;
  accentColor: string;
  onCommit: (next: number) => void;
}

function SelfContainedBrightnessRow({
  initialPercent,
  disabled,
  accentColor,
  onCommit,
}: SelfContainedBrightnessRowProps) {
  const { t } = useTranslation("common");
  const [localPercent, setLocalPercent] = useState(initialPercent);
  const isDraggingRef = useRef(false);

  // Always-latest onCommit so the throttle timer never fires a stale
  // callback captured from an earlier render.
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  // Throttle state: pending percent + timer. Brightness commits to the
  // parent are capped at 20 Hz (50 ms min interval) regardless of
  // pointer rate so the parent's state updates — which cascade into a
  // full CompactLayout reconciliation — do not run at 120 Hz and stall
  // the slider thumb mid-drag.
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

  // Sync from external changes only when the user isn't currently
  // dragging. If the parent's value drifts (mode switch, preset click)
  // we pick it up; during a drag we keep the local value authoritative
  // so a throttled commit echo doesn't yank the thumb back.
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
    // Guarantee the final released value lands even if the throttle
    // window hasn't elapsed yet — otherwise the last micro-drag could
    // sit in the pending ref unobserved by the backend.
    if (throttleRef.current.timer !== null) {
      window.clearTimeout(throttleRef.current.timer);
      throttleRef.current.timer = null;
    }
    flushCommit();
  }, [flushCommit]);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-[0.12em] uppercase text-slate-500 dark:text-zinc-400">
          {t("general.mode.brightness")}
        </span>
        <span className="text-[11px] font-medium tabular-nums text-slate-600 dark:text-zinc-300">
          {localPercent}%
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={localPercent}
        disabled={disabled}
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
        // IMPORTANT: no transition on the thumb. The webkit slider thumb
        // position is updated by the native range widget on every pointer
        // event; animating transforms on it makes the drag visibly stutter
        // because each micro-update animates over ~150ms.
        className="h-2 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[var(--accent-color)] [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_2px_6px_rgba(0,0,0,0.35)]"
        style={{
          background: `linear-gradient(90deg, #0a0a0a 0%, ${accentColor} 100%)`,
        }}
      />
    </div>
  );
}

interface StatusDotProps {
  label: string;
  active: boolean;
  available: boolean;
}

function StatusDot({ label, active, available }: StatusDotProps) {
  const dotColor = active
    ? "bg-emerald-500 animate-pulse"
    : available
      ? "bg-emerald-500"
      : "bg-slate-300 dark:bg-zinc-700";
  const textColor = available
    ? "text-slate-600 dark:text-zinc-300"
    : "text-slate-400 dark:text-zinc-600";

  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
      <span className={`text-[10px] font-medium ${textColor}`}>{label}</span>
    </div>
  );
}
