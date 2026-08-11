/**
 * PatternPicker — choose a synthetic test pattern + its animation cadence.
 *
 * Two-column tiles for the five `LED_TEST_PATTERN_KIND` values plus a shared
 * slow / med / fast speed control. Speed only applies to time-varying patterns
 * (`chase` / `rainbow` / `spiral`); for the static `solid` / `gamut` patterns
 * the speed control is disabled with `aria-disabled` so it reads as
 * intentionally inert rather than broken.
 *
 * The "running" indicator pulse is guarded by `prefers-reduced-motion` through
 * the `.lm-test-pulse` rule in `styles.css`.
 */

import { useTranslation } from "react-i18next";

import {
  LED_TEST_PATTERN_KIND,
  type LedTestPatternKind,
  type TestPatternSpeed,
} from "../../../shared/contracts/preview";

/** Representative swatch gradient per pattern kind. */
const SWATCH: Record<LedTestPatternKind, string> = {
  solid: "var(--lm-amber)",
  chase: "linear-gradient(90deg, var(--lm-amber) 0%, transparent 70%)",
  rainbow: "linear-gradient(90deg, #ef5b5b, #ffb020, #4ade80, #22d3ee, #a855f7)",
  spiral: "conic-gradient(from 0deg, #ef5b5b, #ffb020, #4ade80, #22d3ee, #a855f7, #ef5b5b)",
  gamut: "linear-gradient(135deg, #ffb020, #ff7a1a, #a855f7, #22d3ee)",
};

const STATIC_KINDS: ReadonlySet<LedTestPatternKind> = new Set(["solid", "gamut"]);
const SPEEDS: TestPatternSpeed[] = ["slow", "med", "fast"];

export interface PatternPickerProps {
  selectedKind: LedTestPatternKind;
  speed: TestPatternSpeed;
  running: boolean;
  disabled?: boolean;
  onSelectKind: (kind: LedTestPatternKind) => void;
  onSpeedChange: (speed: TestPatternSpeed) => void;
}

export function PatternPicker({
  selectedKind,
  speed,
  running,
  disabled = false,
  onSelectKind,
  onSpeedChange,
}: PatternPickerProps) {
  const { t } = useTranslation("common");
  const speedDisabled = disabled || STATIC_KINDS.has(selectedKind);

  return (
    <div>
      <div className="lm-control-section-title flex items-center justify-between">
        <span>{t("ledPreview.test.title")}</span>
        {running && (
          <span className="inline-flex items-center gap-1.5 text-[var(--lm-amber)]">
            <span className="lm-test-pulse" aria-hidden="true" />
            <span className="[font-family:var(--lm-mono)] text-[9px] tracking-wide">
              {t("ledPreview.test.running")}
            </span>
          </span>
        )}
      </div>

      <div className="lm-pattern-grid" role="radiogroup" aria-label={t("ledPreview.test.title")}>
        {LED_TEST_PATTERN_KIND.map((kind) => {
          const on = kind === selectedKind;
          return (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              className={`lm-pattern-tile ${on ? "is-on" : ""}`}
              onClick={() => onSelectKind(kind)}
            >
              <span className="swatch" style={{ background: SWATCH[kind] }} aria-hidden="true" />
              <span>{t(`ledPreview.pattern.${kind}`)}</span>
            </button>
          );
        })}
      </div>

      <div
        className="lm-pattern-speed"
        role="radiogroup"
        aria-label={t("ledPreview.test.speed.label")}
        aria-disabled={speedDisabled}
      >
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={s === speed}
            disabled={speedDisabled}
            className={s === speed ? "is-on" : ""}
            onClick={() => onSpeedChange(s)}
          >
            {t(`ledPreview.test.speed.${s}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
