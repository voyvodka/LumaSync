/**
 * HueIntensityPresetControl — v1.4 G6 Hue smoothing tier.
 *
 * Three-tile segmented control (Subtle / Moderate / Intense) that sets the
 * EWMA coefficient applied to the Hue branch of the ambilight pump. The
 * user picks the feel — bedroom-calm, balanced, or gaming-snappy — and the
 * Rust runtime reads the coefficient from `HUE_INTENSITY_PRESET_COEFFICIENTS`
 * when hydrating `AmbilightLiveSettings::hue_smoothing_alpha`.
 *
 * Persisted to `shellStore.lightingIntensityPreset`. On change the parent
 * hot-reloads the active ambilight worker through `set_lighting_mode` so
 * the new preset rides the next frame without a mode toggle (see
 * `withAmbilightHueIntensityPreset` in App.tsx).
 *
 * Accessibility:
 *   - `role="radiogroup"` and per-tile `role="radio"` semantics.
 *   - Amber focus ring via `.lm-settings-seg button:focus-visible`.
 *   - Description line gives context-free copy for screen readers.
 *   - Arrow-key navigation follows the same roving-tabindex pattern as
 *     FirmwareProfilePicker so keyboard users can cycle presets without
 *     leaving the radio group.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DEFAULT_HUE_INTENSITY_PRESET,
  type HueIntensityPreset,
} from "../../../../shared/contracts/hue";
import { shellStore } from "../../../persistence/shellStore";

const PRESET_ORDER: HueIntensityPreset[] = ["subtle", "moderate", "intense"];

export interface HueIntensityPresetControlProps {
  /** Initial preset from shellStore — parent hydrates before first paint. */
  initialPreset?: HueIntensityPreset;
  /**
   * Fired after persistence completes so the parent can hot-reload the
   * running ambilight worker.
   */
  onPresetChange?: (next: HueIntensityPreset) => void;
}

export function HueIntensityPresetControl({
  initialPreset,
  onPresetChange,
}: HueIntensityPresetControlProps) {
  const { t } = useTranslation("common");
  const [preset, setPreset] = useState<HueIntensityPreset>(
    initialPreset ?? DEFAULT_HUE_INTENSITY_PRESET,
  );
  const buttonRefs = useRef<Record<HueIntensityPreset, HTMLButtonElement | null>>({
    subtle: null,
    moderate: null,
    intense: null,
  });

  useEffect(() => {
    if (initialPreset) return;
    let cancelled = false;
    void shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        if (state.lightingIntensityPreset) {
          setPreset(state.lightingIntensityPreset);
        }
      })
      .catch((error) => {
        console.error(
          "[LumaSync] HueIntensityPresetControl hydrate failed:",
          error,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [initialPreset]);

  const commit = useCallback(
    (next: HueIntensityPreset) => {
      if (next === preset) return;
      setPreset(next);
      void shellStore
        .save({ lightingIntensityPreset: next })
        .catch((error) => {
          console.error(
            "[LumaSync] shellStore.save(lightingIntensityPreset) failed:",
            error,
          );
        });
      onPresetChange?.(next);
    },
    [onPresetChange, preset],
  );

  const handleKeyNavigate = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, current: HueIntensityPreset) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const idx = PRESET_ORDER.indexOf(current);
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const nextIdx = (idx + delta + PRESET_ORDER.length) % PRESET_ORDER.length;
      const nextPreset = PRESET_ORDER[nextIdx];
      commit(nextPreset);
      buttonRefs.current[nextPreset]?.focus();
    },
    [commit],
  );

  const presetLabels: Record<HueIntensityPreset, string> = useMemo(
    () => ({
      subtle: t("device.hue.intensity.subtle"),
      moderate: t("device.hue.intensity.moderate"),
      intense: t("device.hue.intensity.intense"),
    }),
    [t],
  );

  return (
    <section className="lm-settings-group">
      <div className="lm-settings-group-h">
        <span className="t">{t("device.hue.intensity.moderate")}</span>
        <span className="sub">{t("device.hue.intensity.description")}</span>
      </div>
      <div className="lm-settings-row">
        <div className="lm-settings-row-l">
          <div className="lm-settings-row-name">
            {t("device.hue.intensity.description")}
          </div>
        </div>
        <div className="lm-settings-row-r">
          <div
            className="lm-settings-seg"
            role="radiogroup"
            aria-label={t("device.hue.intensity.description")}
          >
            {PRESET_ORDER.map((candidate) => {
              const isActive = candidate === preset;
              return (
                <button
                  key={candidate}
                  ref={(el) => {
                    buttonRefs.current[candidate] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  tabIndex={isActive ? 0 : -1}
                  className={isActive ? "is-on" : ""}
                  onClick={() => commit(candidate)}
                  onKeyDown={(e) => handleKeyNavigate(e, candidate)}
                >
                  {presetLabels[candidate]}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
