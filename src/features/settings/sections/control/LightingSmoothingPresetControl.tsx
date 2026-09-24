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
 * generic — always covered both branches). The save is what reaches the
 * running worker: Rust re-applies the mode once a setting it reads is saved
 * (docs/architecture/lighting-transaction.md, "Settings refresh").
 *
 * Accessibility:
 *   - `role="radiogroup"` and per-tile `role="radio"` semantics.
 *   - Amber focus ring via `.lm-settings-seg button:focus-visible`.
 *   - Description line gives context-free copy for screen readers.
 *   - Arrow keys, Home and End move within the group (`Segmented`).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DEFAULT_LIGHTING_SMOOTHING_PRESET,
  type LightingSmoothingPreset,
} from "@/shared/contracts/lighting";
import { shellStore } from "@/features/persistence/shellStore";
import { Segmented } from "@/shared/ui/Segmented";

const PRESET_ORDER: LightingSmoothingPreset[] = ["subtle", "moderate", "intense"];

export interface LightingSmoothingPresetControlProps {
  /** Initial preset from shellStore — parent hydrates before first paint. */
  initialPreset?: LightingSmoothingPreset;
  /** Fired after the save is requested, for a parent that mirrors the choice. */
  onPresetChange?: (next: LightingSmoothingPreset) => void;
}

export function LightingSmoothingPresetControl({
  initialPreset,
  onPresetChange,
}: LightingSmoothingPresetControlProps) {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<LightingSmoothingPreset>(
    initialPreset ?? DEFAULT_LIGHTING_SMOOTHING_PRESET,
  );

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

  const presetLabels: Record<LightingSmoothingPreset, string> = useMemo(
    () => ({
      subtle: t("lights:signal.smoothing.subtle"),
      moderate: t("lights:signal.smoothing.moderate"),
      intense: t("lights:signal.smoothing.intense"),
    }),
    [t],
  );

  return (
    <div className="lm-psl lm-psl-seg">
      <div className="row">
        <span>{t("lights:signal.smoothing.title")}</span>
        <b>{presetLabels[preset]}</b>
      </div>
      <Segmented
        className="lm-settings-seg"
        ariaLabel={t("lights:signal.smoothing.title")}
        value={preset}
        onChange={commit}
        options={PRESET_ORDER.map((candidate) => ({
          value: candidate,
          label: presetLabels[candidate],
        }))}
      />
    </div>
  );
}
