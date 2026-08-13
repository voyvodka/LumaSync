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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { HsvColorPicker } from "@/shared/ui/HsvColorPicker";
import { IconOff, IconAmbilight, IconSolid } from "@/shared/ui/icons";
import {
  LIGHTING_MODE_KIND,
  type LightingModeConfig,
  type LightingModeKind,
} from "@/features/mode/model/contracts";
import {
  MODE_GUARD_REASONS,
  type ModeGuardReason,
} from "@/features/mode/state/modeGuard";
import type { HueIntensityPreset, HueRuntimeTarget } from "@/shared/contracts/hue";
import { FIRMWARE_PROFILE, type FirmwareProfile } from "@/shared/contracts/device";
import { SCENE_PRESETS, type ScenePreset } from "@/features/mode/model/scenePresets";
import { LightingSmoothingPresetControl } from "../control/LightingSmoothingPresetControl";
import { shellStore } from "@/features/persistence/shellStore";
import { HERO_LIGHT_TILE_THRESHOLD, perceivedLuminance, rgbToHex } from "./colorMath";

interface CompactLayoutProps {
  lightingMode: LightingModeConfig;
  outputTargets: HueRuntimeTarget[];
  usbConnected: boolean;
  hueConfigured: boolean;
  hueReachable: boolean;
  isModeTransitioning: boolean;
  modeLockReason: ModeGuardReason | null;
  onLightingModeChange: (next: LightingModeConfig) => void;
  /**
   * v1.5 W2-B1 — deep-link from the compact-mode "no reachable output"
   * banner into the DEVICES section. Optional so callers that wire the
   * compact layout outside the main shell (test fixtures, storybook)
   * can omit it; in production App.tsx supplies a `handleSectionChange`
   * bound to `SECTION_IDS.DEVICES`.
   */
  onOpenDevices?: () => void;
  /**
   * v1.5 W2 fix #40 — Compact ↔ Full feature parity for the lighting
   * smoothing preset. The compact ambilight card mounts the same
   * `LightingSmoothingPresetControl` the Lights section uses, and forwards
   * a chosen preset back to the parent so the running worker hot-reloads.
   * Optional so test fixtures can mount the layout without wiring it.
   */
  onHueIntensityPresetChange?: (preset: HueIntensityPreset) => void;
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
  onOpenDevices,
  onHueIntensityPresetChange,
}: CompactLayoutProps) {
  const { t } = useTranslation();

  // Needed for brightness-lock parity with full mode: the Adalight wire format
  // has no brightness field, so without this the compact slider moves and the
  // firmware silently swallows the byte.
  const [firmwareProfile, setFirmwareProfile] = useState<FirmwareProfile | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        setFirmwareProfile(state.firmwareProfile);
      })
      .catch((error) => {
        console.error("[LumaSync] CompactLayout firmwareProfile hydrate failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const isAdalight = firmwareProfile === FIRMWARE_PROFILE.ADALIGHT;
  const adalightLockReason = isAdalight
    ? t("lights:led.firmwareProfile.brightnessDisabledTooltip")
    : undefined;

  const incomingSolid = lightingMode.solid ?? DEFAULT_SOLID;
  const ambilightConfig = lightingMode.ambilight ?? DEFAULT_AMBILIGHT;
  const isOff = lightingMode.kind === LIGHTING_MODE_KIND.OFF;
  const isSolid = lightingMode.kind === LIGHTING_MODE_KIND.SOLID;
  const isAmbilight = lightingMode.kind === LIGHTING_MODE_KIND.AMBILIGHT;

  // Without this gate the worker spins up with nowhere to send frames — a
  // running Ambilight state and no reachable output.
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

  // Already in SOLID keeps the user's brightness so manual tweaks survive;
  // entering fresh takes the preset's own so the scene lands as intended.
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
    <div className="lm-compact" data-testid="compact-layout">
      <div className="lm-compact-body">
        {/* ── Offline banner (v1.5 W2-B1) ───────────────────────────
            Compact-friendly inline message + deep-link into DEVICES.
            Shown only when neither USB nor Hue is reachable; non-Off
            modes are already guarded by `nonOffDisabled`, so this
            replaces the silent "buttons are dim" affordance with an
            explicit recovery path. */}
        {activationBlocked && (
          <div className="lm-compact-offline" role="status" aria-live="polite">
            <div className="lm-compact-offline-text">
              <div className="ttl">{t("common:compact.offline.title")}</div>
              <div className="sub">{t("common:compact.offline.body")}</div>
            </div>
            {onOpenDevices && (
              <button
                type="button"
                className="lm-compact-offline-action"
                onClick={onOpenDevices}
              >
                {t("common:compact.offline.action")}
              </button>
            )}
          </div>
        )}

        {/* ── Mode strip ─────────────────────────────────────────── */}
        <div>
          <div className="lm-compact-section-title">{t("common:compact.sections.mode")}</div>
          <div className="lm-compact-mode-strip">
            <ModeButton
              kind={LIGHTING_MODE_KIND.OFF}
              active={isOff}
              disabled={isModeTransitioning}
              label={t("common:mode.options.off")}
              icon={<IconOff />}
              onClick={handleModeClick}
            />
            <ModeButton
              kind={LIGHTING_MODE_KIND.AMBILIGHT}
              active={isAmbilight}
              disabled={nonOffDisabled}
              label={t("common:mode.options.ambilight")}
              icon={<IconAmbilight />}
              onClick={handleModeClick}
            />
            <ModeButton
              kind={LIGHTING_MODE_KIND.SOLID}
              active={isSolid}
              disabled={nonOffDisabled}
              label={t("common:mode.options.solid")}
              icon={<IconSolid />}
              onClick={handleModeClick}
            />
          </div>
        </div>

        {/* ── Active mode card ──────────────────────────────────── */}
        {isAmbilight && (
          <div className="lm-compact-card">
            <div className="lm-compact-card-header">
              <div className="l">{t("common:mode.options.ambilight")}</div>
            </div>
            <SelfContainedBrightnessRow
              initialPercent={ambilightBrightnessPct}
              disabled={nonOffDisabled || isAdalight}
              brightnessDisabledReason={adalightLockReason}
              onCommit={handleAmbilightBrightnessCommit}
            />
            {/* v1.5 W2 fix #40 — smoothing preset parity with full mode.
                Reuses the same control + persistence path so the chosen
                preset hot-reloads the worker through App.tsx without a
                mode toggle. */}
            <div className="lm-compact-smoothing">
              <LightingSmoothingPresetControl
                onPresetChange={(next) => onHueIntensityPresetChange?.(next)}
              />
            </div>
          </div>
        )}

        {isSolid && (
          <CompactSolidSection
            incoming={incomingSolid}
            disabled={nonOffDisabled}
            onCommit={handleSolidCommit}
            label={t("common:mode.options.solid")}
            sublabel={t("common:mode.solidColor")}
            brightnessDisabled={isAdalight}
            brightnessDisabledReason={adalightLockReason}
          />
        )}

        {/* ── Scene presets ──────────────────────────────────────── */}
        <div>
          <div className="lm-compact-section-title">
            {t("common:compact.sections.scene")}
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
      data-testid={`mode-button-${kind}`}
    >
      <span className="ico">{icon}</span>
      <span className="tn">{label}</span>
    </button>
  );
}

/** Solid mode card. The draft lives here rather than in `CompactLayout` on
 *  purpose — hoisted, every brightness tick reconciled the mode strip and
 *  scene row too. */

const BRIGHTNESS_COMMIT_MIN_INTERVAL_MS = 50;

interface CompactSolidSectionProps {
  incoming: { r: number; g: number; b: number; brightness: number };
  disabled: boolean;
  /** v1.5 W2 fix #41 — Adalight firmware lock parity with full Lights view. */
  brightnessDisabled?: boolean;
  /** Tooltip / mono notice surfaced when `brightnessDisabled` is true. */
  brightnessDisabledReason?: string;
  label: string;
  sublabel: string;
  onCommit: (payload: { r: number; g: number; b: number; brightness: number }) => void;
}

function CompactSolidSection({
  incoming,
  disabled,
  brightnessDisabled = false,
  brightnessDisabledReason,
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
        disabled={disabled || brightnessDisabled}
        brightnessDisabledReason={brightnessDisabled ? brightnessDisabledReason : undefined}
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

/** Popover sizing constants used to clamp the position into the viewport.
 *  Width matches the rendered HsvColorPicker(compact) + 12 px wrapper padding.
 *  The height is now dynamically measured (see `useLayoutEffect` below) so
 *  that variable-height surfaces — recent-colors strip in particular —
 *  position correctly. The fallback estimate is only used during the very
 *  first render before the popover commits to the DOM. */
const POPOVER_WIDTH_PX = 200;
const POPOVER_FALLBACK_HEIGHT_PX = 270;
const POPOVER_VIEWPORT_MARGIN_PX = 8;

function HeroColorCard({ rgb, disabled, sublabel, onChange }: HeroColorCardProps) {
  const { t } = useTranslation();
  const hex = rgbToHex(rgb);
  const isLight = perceivedLuminance(rgb) > HERO_LIGHT_TILE_THRESHOLD;
  const textColor = isLight ? "rgba(0,0,0,0.82)" : "rgba(255,255,255,0.92)";
  const subTextColor = isLight ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.65)";
  const edgeColor = isLight ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.18)";
  const eyeBg = isLight ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.28)";

  // Portalled and positioned from a measured height, both load-bearing at
  // 320×480 — see docs/architecture/ui-and-shell.md.
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [popoverPos, setPopoverPos] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);

  const recomputePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    // Prefer the live measurement of the rendered popover; fall back to the
    // estimate only on the very first pass before the DOM has the node.
    const measuredHeight = popoverRef.current?.offsetHeight;
    const desiredHeight = measuredHeight && measuredHeight > 0
      ? measuredHeight
      : POPOVER_FALLBACK_HEIGHT_PX;

    // Available space below the trigger and above it, both already
    // accounting for the 8 px viewport margin.
    const spaceBelow =
      window.innerHeight - rect.bottom - POPOVER_VIEWPORT_MARGIN_PX - 6;
    const spaceAbove = rect.top - POPOVER_VIEWPORT_MARGIN_PX - 6;
    // Pick the side with more room. If neither side fits the popover in
    // full, the larger side hosts the popover with internal scroll.
    const placeAbove = spaceAbove > spaceBelow && desiredHeight > spaceBelow;
    const availableSpace = placeAbove ? spaceAbove : spaceBelow;
    // The popover is allowed to consume the entire available side, capped
    // by the viewport. The CSS rule `overflow-y: auto` inside the popover
    // wrapper does the actual scrolling once the picker exceeds maxHeight.
    const viewportCap =
      window.innerHeight - POPOVER_VIEWPORT_MARGIN_PX * 2;
    const maxHeight = Math.max(120, Math.min(availableSpace, viewportCap));
    const renderHeight = Math.min(desiredHeight, maxHeight);

    const top = placeAbove
      ? Math.max(POPOVER_VIEWPORT_MARGIN_PX, rect.top - renderHeight - 6)
      : Math.min(
          rect.bottom + 6,
          window.innerHeight - renderHeight - POPOVER_VIEWPORT_MARGIN_PX,
        );
    let left = rect.left + rect.width / 2 - POPOVER_WIDTH_PX / 2;
    // Centre-anchoring rarely overflows at 320 px, but resizing the window while
    // the popover is open pushes it flush against the right edge without this.
    const maxLeft = window.innerWidth - POPOVER_WIDTH_PX - POPOVER_VIEWPORT_MARGIN_PX;
    if (left < POPOVER_VIEWPORT_MARGIN_PX) left = POPOVER_VIEWPORT_MARGIN_PX;
    if (left > maxLeft) left = Math.max(POPOVER_VIEWPORT_MARGIN_PX, maxLeft);
    setPopoverPos({ left, top, maxHeight });
  }, []);

  useEffect(() => {
    if (!open) {
      setPopoverPos(null);
      return;
    }
    recomputePosition();
    const onResize = () => recomputePosition();
    const onScroll = () => recomputePosition();
    window.addEventListener("resize", onResize);
    // Capture-phase scroll listener catches scrolls inside compact-body
    // (which is the actual scroller — the window itself does not scroll).
    window.addEventListener("scroll", onScroll, true);
    const onDoc = (e: MouseEvent) => {
      if (popoverRef.current?.contains(e.target as Node)) return;
      if (triggerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, recomputePosition]);

  // Second pass of the two-pass positioning — the fallback estimate is only
  // ever what the first, invisible render uses.
  useLayoutEffect(() => {
    if (!open) return;
    recomputePosition();
    const node = popoverRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => recomputePosition());
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, recomputePosition]);

  const popover = open && popoverPos ? (
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="false"
      aria-label={t("common:mode.solidColor")}
      className="lm-compact-color-popover"
      style={{
        position: "fixed",
        left: popoverPos.left,
        top: popoverPos.top,
        width: POPOVER_WIDTH_PX,
        maxHeight: popoverPos.maxHeight,
        zIndex: 1000,
      }}
    >
      <HsvColorPicker
        value={hex}
        onChange={onChange}
        disabled={disabled}
        ariaLabel={t("common:mode.solidColor")}
        compact
      />
    </div>
  ) : null;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        className={`lm-compact-hero ${disabled ? "is-disabled" : ""}`}
        aria-label={t("common:mode.solidColor")}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => { if (!disabled) setOpen((v) => !v); }}
        style={{
          backgroundColor: hex,
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
      </button>
      {popover && createPortal(popover, document.body)}
    </div>
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

/** Throttled range input. `initialPercent` re-syncs on external drift, but only
 *  while the user is not dragging — otherwise an echo commit snaps the thumb. */

interface SelfContainedBrightnessRowProps {
  initialPercent: number;
  disabled: boolean;
  /**
   * Mono mini-notice rendered under the slider when the row is disabled
   * for a firmware-level reason (Adalight, primarily). Mirrors the
   * SolidColorPanel surface in full mode so users see the same copy
   * regardless of which window they're in.
   */
  brightnessDisabledReason?: string;
  onCommit: (next: number) => void;
}

function SelfContainedBrightnessRow({
  initialPercent,
  disabled,
  brightnessDisabledReason,
  onCommit,
}: SelfContainedBrightnessRowProps) {
  const { t } = useTranslation();
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
        <span>{t("common:mode.brightness")}</span>
        <b>{localPercent}%</b>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={localPercent}
        disabled={disabled}
        aria-disabled={disabled}
        title={brightnessDisabledReason}
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
      {brightnessDisabledReason && (
        <div className="lm-compact-brightness-note" role="note">
          {brightnessDisabledReason}
        </div>
      )}
    </div>
  );
}
