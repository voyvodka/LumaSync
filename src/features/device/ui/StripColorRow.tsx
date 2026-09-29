import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DEFAULT_COLOR_CORRECTION,
  GAMMA_RANGE,
  KELVIN_RANGE_K,
  SATURATION_RANGE,
  type ColorCorrectionConfig,
} from "@/shared/contracts/device";
import { shellStore } from "@/features/persistence/shellStore";
import { withColorCorrection } from "@/features/strips/model/stripWrites";
import { clamp } from "@/shared/lib/math";
import { Popover } from "@/shared/ui/Popover/Popover";
import { RangeRow } from "@/shared/ui/RangeRow/RangeRow";
import { RowButton, SettingRow } from "@/shared/ui/SettingRow/SettingRow";
import styles from "./StripPage.module.css";

const PERSIST_DEBOUNCE_MS = 200;

export function isDefaultCorrection(config: ColorCorrectionConfig): boolean {
  return (
    Math.abs(config.gammaR - DEFAULT_COLOR_CORRECTION.gammaR) < 1e-3 &&
    Math.abs(config.gammaG - DEFAULT_COLOR_CORRECTION.gammaG) < 1e-3 &&
    Math.abs(config.gammaB - DEFAULT_COLOR_CORRECTION.gammaB) < 1e-3 &&
    Math.abs(config.kelvin - DEFAULT_COLOR_CORRECTION.kelvin) < 1 &&
    Math.abs(config.saturation - DEFAULT_COLOR_CORRECTION.saturation) < 1e-3
  );
}

/**
 * A strip's colour calibration: gamma per channel, white point and a saturation trim that matches
 * this output to the others. The look of a mode stays on Lights. One value for every output until
 * each strip has its own — the ⓘ says so. Saving re-applies the running mode (lighting-transaction.md).
 */
export function StripColorRow() {
  const { t } = useTranslation();
  // `null` until the store answers: the row keeps its value empty rather than showing a default.
  const [config, setConfig] = useState<ColorCorrectionConfig | null>(null);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverId = useId();
  const persistTimer = useRef<number | null>(null);
  const pending = useRef<ColorCorrectionConfig | null>(null);
  // Writes not yet answered: the echo of an older one must not put the slider back.
  const inFlight = useRef(0);

  const save = useCallback((next: ColorCorrectionConfig) => {
    inFlight.current += 1;
    shellStore
      .update((current) => withColorCorrection(current, next))
      .catch((error: unknown) => {
        console.error("[LumaSync] saving the colour correction failed:", error);
      })
      .finally(() => {
        inFlight.current -= 1;
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    shellStore
      .load()
      .then((state) => {
        if (!cancelled) setConfig(state.colorCorrection ?? { ...DEFAULT_COLOR_CORRECTION });
      })
      .catch((error: unknown) => {
        console.error("[LumaSync] reading the colour correction failed:", error);
        if (!cancelled) setConfig({ ...DEFAULT_COLOR_CORRECTION });
      });
    const stop = shellStore.onSaved((saved) => {
      if ("colorCorrection" in saved && persistTimer.current === null && inFlight.current === 0) {
        setConfig(saved.colorCorrection ?? { ...DEFAULT_COLOR_CORRECTION });
      }
    });
    return () => {
      cancelled = true;
      stop();
      // Leaving the page inside the debounce still saves the last value.
      if (persistTimer.current !== null) {
        window.clearTimeout(persistTimer.current);
        persistTimer.current = null;
        if (pending.current) save(pending.current);
      }
    };
  }, [save]);

  const commit = useCallback(
    (next: ColorCorrectionConfig) => {
      setConfig(next);
      pending.current = next;
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
      persistTimer.current = window.setTimeout(() => {
        persistTimer.current = null;
        pending.current = null;
        save(next);
      }, PERSIST_DEBOUNCE_MS);
    },
    [save],
  );

  const summary =
    config === null
      ? ""
      : isDefaultCorrection(config)
        ? t("device:strip.color.default")
        : t("device:strip.color.summary", {
            kelvin: config.kelvin,
            gamma: [config.gammaR, config.gammaG, config.gammaB].map((g) => g.toFixed(1)).join(" / "),
            saturation: config.saturation.toFixed(2),
          });

  return (
    <SettingRow
      label={t("device:strip.row.color")}
      hint={t("device:strip.color.hint")}
      value={<span data-testid="strip-color-value">{summary}</span>}
      testId="strip-color"
      control={
        <>
          <RowButton
            ref={buttonRef}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? popoverId : undefined}
            disabled={config === null}
            onClick={() => setOpen((v) => !v)}
            data-testid="strip-color-edit"
          >
            {t("device:strip.color.edit")}
          </RowButton>
          <Popover
            open={open && config !== null}
            onClose={() => setOpen(false)}
            anchorRef={buttonRef}
            side="below"
            width={420}
            id={popoverId}
            role="dialog"
            label={t("device:strip.row.color")}
          >
            {config ? <CorrectionControls config={config} onChange={commit} /> : null}
          </Popover>
        </>
      }
    />
  );
}

function CorrectionControls({
  config,
  onChange,
}: {
  config: ColorCorrectionConfig;
  onChange: (next: ColorCorrectionConfig) => void;
}) {
  const { t } = useTranslation();
  const gamma = (key: "gammaR" | "gammaG" | "gammaB", label: string) => (
    <RangeRow
      variant="stage"
      label={label}
      min={GAMMA_RANGE.min}
      max={GAMMA_RANGE.max}
      step={0.1}
      value={config[key]}
      valueLabel={config[key].toFixed(1)}
      onChange={(next) => onChange({ ...config, [key]: clamp(next, GAMMA_RANGE.min, GAMMA_RANGE.max) })}
      testId={`strip-color-${key}`}
    />
  );
  return (
    <div className={styles.correction} data-testid="strip-color-controls">
      {gamma("gammaR", t("lights:led.colorCorrection.gammaR"))}
      {gamma("gammaG", t("lights:led.colorCorrection.gammaG"))}
      {gamma("gammaB", t("lights:led.colorCorrection.gammaB"))}
      <RangeRow
        variant="stage"
        label={t("lights:led.colorCorrection.kelvin")}
        ariaLabel={`${t("lights:led.colorCorrection.kelvin")} — ${t("lights:led.colorCorrection.kelvinHint")}`}
        min={KELVIN_RANGE_K.min}
        max={KELVIN_RANGE_K.max}
        step={100}
        value={config.kelvin}
        valueLabel={`${config.kelvin} K`}
        onChange={(next) =>
          onChange({ ...config, kelvin: clamp(Math.round(next / 100) * 100, KELVIN_RANGE_K.min, KELVIN_RANGE_K.max) })
        }
        testId="strip-color-kelvin"
      />
      <RangeRow
        variant="stage"
        label={t("lights:led.colorCorrection.saturation")}
        min={SATURATION_RANGE.min}
        max={SATURATION_RANGE.max}
        step={0.05}
        value={config.saturation}
        valueLabel={`×${config.saturation.toFixed(2)}`}
        onChange={(next) =>
          onChange({ ...config, saturation: clamp(next, SATURATION_RANGE.min, SATURATION_RANGE.max) })
        }
        testId="strip-color-saturation"
      />
      <div className={styles.correctionFoot}>
        <RowButton
          onClick={() => onChange({ ...DEFAULT_COLOR_CORRECTION })}
          disabled={isDefaultCorrection(config)}
          data-testid="strip-color-reset"
        >
          {t("lights:led.colorCorrection.reset")}
        </RowButton>
      </div>
    </div>
  );
}
