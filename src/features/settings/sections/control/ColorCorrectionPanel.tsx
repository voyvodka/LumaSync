/**
 * ColorCorrectionPanel — v1.4 G4 LED color correction editor.
 *
 * Renders the per-channel gamma (R/G/B), white-point Kelvin, and saturation
 * sliders that feed the Rust LED encoder. State is persisted to
 * `shellStore.colorCorrection`; on every commit the hot `set_lighting_mode`
 * path rides the updated config into the active worker (see App.tsx).
 *
 * The panel is rendered inside `LightsSection` as a collapsible
 * `lm-settings-group` so compact mode (320 px) can hide the dense slider
 * stack while full mode (900 px) has room for all five rows. The collapse
 * state is derived: if the config deviates from `DEFAULT_COLOR_CORRECTION`
 * the section auto-expands, making the "advanced" controls self-announcing
 * when the user has been editing them.
 *
 * Accessibility:
 *   - Each slider carries a descriptive `aria-label` + live value label.
 *   - `focus-visible` amber ring inherited from `.lm-settings-seg` tokens.
 *   - Slider step sizes match the contract ranges — no silent quantisation.
 *   - `prefers-reduced-motion` honoured via global utility on transitions.
 *   - Reset button is keyboard reachable and labelled.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DEFAULT_COLOR_CORRECTION,
  GAMMA_RANGE,
  KELVIN_RANGE_K,
  SATURATION_RANGE,
  type ColorCorrectionConfig,
} from "../../../../shared/contracts/device";
import { shellStore } from "../../../persistence/shellStore";

const PERSIST_DEBOUNCE_MS = 200;

/**
 * Test whether the given config equals the factory default (within float
 * precision). Used to auto-collapse the panel when the user has not
 * customised anything, and to know when the Reset button has visible
 * effect.
 */
function isDefaultCorrection(config: ColorCorrectionConfig): boolean {
  return (
    Math.abs(config.gammaR - DEFAULT_COLOR_CORRECTION.gammaR) < 1e-3 &&
    Math.abs(config.gammaG - DEFAULT_COLOR_CORRECTION.gammaG) < 1e-3 &&
    Math.abs(config.gammaB - DEFAULT_COLOR_CORRECTION.gammaB) < 1e-3 &&
    Math.abs(config.kelvin - DEFAULT_COLOR_CORRECTION.kelvin) < 1 &&
    Math.abs(config.saturation - DEFAULT_COLOR_CORRECTION.saturation) < 1e-3
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface SliderRowProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  valueLabel: string;
  ariaLabel: string;
  onChange: (next: number) => void;
}

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  valueLabel,
  ariaLabel,
  onChange,
}: SliderRowProps) {
  // Local percent for the amber fill track — matches `lm-psl` pattern used
  // in LightsSection so the look is identical to the Ambilight profile
  // block directly above this panel.
  const percent = ((value - min) / (max - min)) * 100;
  return (
    <div className="lm-psl">
      <div className="row">
        <span>{label}</span>
        <b>{valueLabel}</b>
      </div>
      <div className="tr">
        <div className="tr-track">
          <span className="tr-fill" style={{ width: `${percent}%` }} />
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={ariaLabel}
          onChange={(e) => {
            const next = Number.parseFloat(e.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
        />
      </div>
    </div>
  );
}

export interface ColorCorrectionPanelProps {
  /**
   * Initial config hydrated from shellStore by the parent on first mount.
   * Re-reads are done internally to survive external resets (e.g. factory
   * reset from SystemSection).
   */
  initialConfig?: ColorCorrectionConfig;
  /**
   * Fired after the panel has persisted a new config to shellStore. The
   * parent uses this to hot-reload the active lighting worker so the new
   * correction takes effect without a mode toggle.
   */
  onConfigChange?: (next: ColorCorrectionConfig) => void;
}

export function ColorCorrectionPanel({
  initialConfig,
  onConfigChange,
}: ColorCorrectionPanelProps) {
  const { t } = useTranslation("common");
  const [config, setConfig] = useState<ColorCorrectionConfig>(
    initialConfig ?? DEFAULT_COLOR_CORRECTION,
  );
  // Auto-expand if the user has customised the defaults — otherwise keep
  // the section collapsed so the settings page stays calm at first sight.
  const [isExpanded, setIsExpanded] = useState<boolean>(() =>
    !isDefaultCorrection(initialConfig ?? DEFAULT_COLOR_CORRECTION),
  );
  const persistTimeoutRef = useRef<number | null>(null);

  // Hydrate once on mount from shellStore in case the parent did not pass
  // `initialConfig` (defensive — keeps component self-sufficient when
  // reused in isolation, e.g. Storybook or Calibration wizard).
  useEffect(() => {
    if (initialConfig) return;
    let cancelled = false;
    void shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        if (state.colorCorrection) {
          setConfig(state.colorCorrection);
          setIsExpanded(!isDefaultCorrection(state.colorCorrection));
        }
      })
      .catch((error) => {
        console.error("[LumaSync] ColorCorrectionPanel hydrate failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [initialConfig]);

  useEffect(() => {
    return () => {
      if (persistTimeoutRef.current !== null) {
        window.clearTimeout(persistTimeoutRef.current);
      }
    };
  }, []);

  const commit = useCallback(
    (next: ColorCorrectionConfig) => {
      setConfig(next);
      if (persistTimeoutRef.current !== null) {
        window.clearTimeout(persistTimeoutRef.current);
      }
      persistTimeoutRef.current = window.setTimeout(() => {
        persistTimeoutRef.current = null;
        void shellStore
          .save({ colorCorrection: next })
          .catch((error) => {
            console.error(
              "[LumaSync] shellStore.save(colorCorrection) failed:",
              error,
            );
          });
      }, PERSIST_DEBOUNCE_MS);
      onConfigChange?.(next);
    },
    [onConfigChange],
  );

  const handleReset = useCallback(() => {
    commit({ ...DEFAULT_COLOR_CORRECTION });
  }, [commit]);

  const canReset = useMemo(() => !isDefaultCorrection(config), [config]);

  return (
    <section className="lm-settings-group">
      <button
        type="button"
        className="lm-settings-group-h"
        aria-expanded={isExpanded}
        aria-controls="lm-color-correction-body"
        onClick={() => setIsExpanded((prev) => !prev)}
        style={{
          width: "100%",
          textAlign: "left",
          cursor: "pointer",
          background: "rgba(255, 255, 255, 0.01)",
          border: "none",
        }}
      >
        <span className="t">{t("ledSettings.colorCorrection.title")}</span>
        <span className="sub">
          {canReset
            ? `${config.kelvin}K · ×${config.saturation.toFixed(2)}`
            : t("ledSettings.colorCorrection.description")}
        </span>
      </button>
      {isExpanded && (
        <div
          id="lm-color-correction-body"
          className="lm-profile"
          style={{ padding: 14 }}
        >
          <SliderRow
            label={t("ledSettings.colorCorrection.gammaR")}
            ariaLabel={t("ledSettings.colorCorrection.gammaR")}
            min={GAMMA_RANGE.min}
            max={GAMMA_RANGE.max}
            step={0.1}
            value={config.gammaR}
            valueLabel={config.gammaR.toFixed(1)}
            onChange={(next) =>
              commit({ ...config, gammaR: clamp(next, GAMMA_RANGE.min, GAMMA_RANGE.max) })
            }
          />
          <SliderRow
            label={t("ledSettings.colorCorrection.gammaG")}
            ariaLabel={t("ledSettings.colorCorrection.gammaG")}
            min={GAMMA_RANGE.min}
            max={GAMMA_RANGE.max}
            step={0.1}
            value={config.gammaG}
            valueLabel={config.gammaG.toFixed(1)}
            onChange={(next) =>
              commit({ ...config, gammaG: clamp(next, GAMMA_RANGE.min, GAMMA_RANGE.max) })
            }
          />
          <SliderRow
            label={t("ledSettings.colorCorrection.gammaB")}
            ariaLabel={t("ledSettings.colorCorrection.gammaB")}
            min={GAMMA_RANGE.min}
            max={GAMMA_RANGE.max}
            step={0.1}
            value={config.gammaB}
            valueLabel={config.gammaB.toFixed(1)}
            onChange={(next) =>
              commit({ ...config, gammaB: clamp(next, GAMMA_RANGE.min, GAMMA_RANGE.max) })
            }
          />
          <SliderRow
            label={t("ledSettings.colorCorrection.kelvin")}
            ariaLabel={`${t("ledSettings.colorCorrection.kelvin")} — ${t("ledSettings.colorCorrection.kelvinHint")}`}
            min={KELVIN_RANGE_K.min}
            max={KELVIN_RANGE_K.max}
            step={100}
            value={config.kelvin}
            valueLabel={`${config.kelvin}K`}
            onChange={(next) =>
              commit({
                ...config,
                kelvin: clamp(Math.round(next / 100) * 100, KELVIN_RANGE_K.min, KELVIN_RANGE_K.max),
              })
            }
          />
          <SliderRow
            label={t("ledSettings.colorCorrection.saturation")}
            ariaLabel={t("ledSettings.colorCorrection.saturation")}
            min={SATURATION_RANGE.min}
            max={SATURATION_RANGE.max}
            step={0.05}
            value={config.saturation}
            valueLabel={`×${config.saturation.toFixed(2)}`}
            onChange={(next) =>
              commit({
                ...config,
                saturation: clamp(next, SATURATION_RANGE.min, SATURATION_RANGE.max),
              })
            }
          />
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              paddingTop: 4,
            }}
          >
            <button
              type="button"
              className="lm-settings-btn"
              onClick={handleReset}
              disabled={!canReset}
              aria-label={t("ledSettings.colorCorrection.reset")}
            >
              {t("ledSettings.colorCorrection.reset")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
