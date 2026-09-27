import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LedCalibrationConfig } from "@/shared/contracts/calibration";
import { Popover } from "@/shared/ui/Popover/Popover";
import { RowButton } from "@/shared/ui/SettingRow/SettingRow";
import { StateSwap } from "@/shared/ui/StateSwap/StateSwap";

import { flashStrip, markStripLit, type FlashDeps, type FlashOutcome } from "../state/stripFlash";
import styles from "./StripPage.module.css";

interface StripFlashProps {
  stripId: string;
  /** The strip's layout; a strip with none flashes its first sixty LEDs. */
  layout?: LedCalibrationConfig;
  /** "retry" after the user said it did not light: the same flash, asked again. */
  label: "flash" | "retry";
  primary?: boolean;
  disabled?: boolean;
  /** A flash that could not reach the strip; `null` clears it. */
  onProblem: (outcome: Exclude<FlashOutcome, "lit"> | null) => void;
  /** Flash once as soon as the button is usable: the strip was just added, and this is its first question. */
  auto?: boolean;
  /** The automatic flash has run; the caller stops asking for it. */
  onAutoDone?: () => void;
  deps?: FlashDeps;
}

/**
 * Lights the strip for a moment, then asks beside the button whether it lit. The answer is the
 * strip's state: "No" turns it into "Didn't light" with what to check, "Yes" clears that.
 */
export function StripFlash({
  stripId,
  layout,
  label,
  primary = false,
  disabled = false,
  onProblem,
  auto = false,
  onAutoDone,
  deps,
}: StripFlashProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement | null>(null);
  const yesRef = useRef<HTMLButtonElement | null>(null);
  const [flashing, setFlashing] = useState(false);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (asking) yesRef.current?.focus();
  }, [asking]);

  const flash = async () => {
    setAsking(false);
    onProblem(null);
    setFlashing(true);
    try {
      const outcome = await flashStrip(layout, deps);
      if (outcome === "lit") setAsking(true);
      else onProblem(outcome);
    } finally {
      setFlashing(false);
    }
  };

  const flashRef = useRef(flash);
  flashRef.current = flash;
  useEffect(() => {
    if (!auto || disabled) return;
    onAutoDone?.();
    void flashRef.current();
  }, [auto, disabled, onAutoDone]);

  const answer = (lit: boolean) => {
    setAsking(false);
    markStripLit(stripId, lit);
    ref.current?.focus();
  };

  return (
    <>
      <RowButton
        ref={ref}
        primary={primary}
        disabled={disabled || flashing}
        aria-busy={flashing || undefined}
        aria-expanded={asking}
        onClick={() => void flash()}
        data-testid="strip-flash"
      >
        <StateSwap
          fit
          state={flashing ? "busy" : "idle"}
          faces={{
            idle: t(label === "retry" ? "device:strip.action.retry" : "device:strip.action.flash"),
            busy: t("device:strip.action.flashing"),
          }}
        />
      </RowButton>
      <Popover
        open={asking}
        onClose={() => setAsking(false)}
        anchorRef={ref}
        side="below"
        width="fit"
        label={t("device:strip.flash.question")}
        role="dialog"
      >
        <div className={styles.question} data-testid="strip-flash-question">
          <p className={styles.questionText}>{t("device:strip.flash.question")}</p>
          <div className={styles.questionActions}>
            <RowButton onClick={() => answer(false)} data-testid="strip-flash-no">
              {t("device:strip.flash.no")}
            </RowButton>
            <RowButton ref={yesRef} primary onClick={() => answer(true)} data-testid="strip-flash-yes">
              {t("device:strip.flash.yes")}
            </RowButton>
          </div>
        </div>
      </Popover>
    </>
  );
}
