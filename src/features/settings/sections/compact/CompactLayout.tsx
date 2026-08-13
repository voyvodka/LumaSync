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

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

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
import { CompactSolidSection } from "./CompactSolidSection";
import { ModeButton } from "./ModeButton";
import { SelfContainedBrightnessRow } from "./SelfContainedBrightnessRow";

interface CompactLayoutProps {
  lightingMode: LightingModeConfig;
  outputTargets: HueRuntimeTarget[];
  usbConnected: boolean;
  hueConfigured: boolean;
  hueReachable: boolean;
  /** The bridge probe stopped after a sustained outage; the banner offers a retry. */
  hueProbeGaveUp?: boolean;
  onRetryHueProbe?: () => void;
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
  hueProbeGaveUp = false,
  onRetryHueProbe,
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
              <div className="ttl">{t("common:output.offline.title")}</div>
              <div className="sub">
                {hueProbeGaveUp
                  ? t("common:output.offline.stoppedBody")
                  : t("common:output.offline.body")}
              </div>
            </div>
            <div className="lm-compact-offline-actions">
              {onOpenDevices && (
                <button
                  type="button"
                  className="lm-compact-offline-action"
                  onClick={onOpenDevices}
                >
                  {t("common:output.offline.action")}
                </button>
              )}
              {hueProbeGaveUp && onRetryHueProbe && (
                <button
                  type="button"
                  className="lm-compact-offline-action is-ghost"
                  onClick={onRetryHueProbe}
                >
                  {t("common:output.offline.retry")}
                </button>
              )}
            </div>
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
