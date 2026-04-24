/**
 * LightingSmoothingPresetControl — v1.4 unified lighting responsiveness.
 *
 * Three-tile segmented control (Subtle / Moderate / Intense) that sets the
 * single EWMA coefficient applied to both the USB and Hue branches of the
 * ambilight pump. Replaces the earlier pair of (a) a continuous smoothing
 * slider on the USB side and (b) a Hue-only intensity preset — one control
 * now drives both sinks so the user doesn't have to tune responsiveness
 * twice.
 *
 * The Rust runtime reads the coefficient from
 * `LIGHTING_SMOOTHING_PRESET_COEFFICIENTS` when hydrating
 * `AmbilightLiveSettings::smoothing_alpha` + the Hue EWMA path.
 *
 * Persisted to `shellStore.lightingIntensityPreset` (field name kept
 * generic — always covered both branches). On change the parent
 * hot-reloads the active ambilight worker through `set_lighting_mode` so
 * the new preset rides the next frame without a mode toggle (see
 * `withAmbilightLightingSmoothingPreset` in App.tsx).
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
  DEFAULT_LIGHTING_SMOOTHING_PRESET,
  type LightingSmoothingPreset,
} from "../../../../shared/contracts/lighting";
import { shellStore } from "../../../persistence/shellStore";

const PRESET_ORDER: LightingSmoothingPreset[] = ["subtle", "moderate", "intense"];

export interface LightingSmoothingPresetControlProps {
  /** Initial preset from shellStore — parent hydrates before first paint. */
  initialPreset?: LightingSmoothingPreset;
  /**
   * Fired after persistence completes so the parent can hot-reload the
   * running ambilight worker.
   */
  onPresetChange?: (next: LightingSmoothingPreset) => void;
}

export function LightingSmoothingPresetControl({
  initialPreset,
  onPresetChange,
}: LightingSmoothingPresetControlProps) {
  const { t } = useTranslation("common");
  const [preset, setPreset] = useState<LightingSmoothingPreset>(
    initialPreset ?? DEFAULT_LIGHTING_SMOOTHING_PRESET,
  );
  const buttonRefs = useRef<Record<LightingSmoothingPreset, HTMLButtonElement | null>>({
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
          "[LumaSync] LightingSmoothingPresetControl hydrate failed:",
          error,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [initialPreset]);

  const commit = useCallback(
    (next: LightingSmoothingPreset) => {
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
    (event: React.KeyboardEvent<HTMLButtonElement>, current: LightingSmoothingPreset) => {
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

  const presetLabels: Record<LightingSmoothingPreset, string> = useMemo(
    () => ({
      subtle: t("lightsPage.signal.smoothing.subtle"),
      moderate: t("lightsPage.signal.smoothing.moderate"),
      intense: t("lightsPage.signal.smoothing.intense"),
    }),
    [t],
  );

  return (
    <section className="lm-settings-group">
      <div className="lm-settings-group-h">
        <span className="t">{t("lightsPage.signal.smoothing.title")}</span>
        <span className="sub">{t("lightsPage.signal.smoothing.description")}</span>
      </div>
      <div className="lm-settings-row">
        <div className="lm-settings-row-r" style={{ width: "100%" }}>
          <div
            className="lm-settings-seg"
            role="radiogroup"
            aria-label={t("lightsPage.signal.smoothing.title")}
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
