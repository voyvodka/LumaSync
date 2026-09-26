import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import styles from "./FirstRunCard.module.css";

/** First visit: the one question LED Setup cannot answer itself, over the dimmed screen. */
export function FirstRunCard({
  leaving = false,
  knownTotal,
  floor,
  ceiling,
  onDistribute,
  onSkip,
}: {
  /** Answered: it plays its exit, and takes no more input. */
  leaving?: boolean;
  knownTotal: number | null;
  floor: number;
  ceiling: number;
  onDistribute: (total: number) => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const [text, setText] = useState(knownTotal ? String(knownTotal) : "");
  const [touched, setTouched] = useState(false);
  // The page opens on the count it knows. One that changes after (a panel bound since the last
  // visit) still fills the card, unless the user has typed.
  useEffect(() => {
    if (!touched && knownTotal) setText(String(knownTotal));
  }, [knownTotal, touched]);
  const total = Number.parseInt(text, 10);
  const valid = Number.isFinite(total) && total >= floor && total <= ceiling;

  return (
    <form
      className={leaving ? `${styles.card} ${styles.leaving}` : styles.card}
      inert={leaving}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onDistribute(total);
      }}
    >
      <label htmlFor={inputId} className={styles.question}>
        {t("calibration:page.totalStep.question")}
      </label>
      <div className={styles.row}>
        <input
          id={inputId}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={text}
          placeholder="0"
          aria-invalid={(text !== "" && !valid) || undefined}
          onChange={(e) => {
            setTouched(true);
            setText(e.target.value.replace(/[^0-9]/g, "").slice(0, 4));
          }}
          className={styles.input}
        />
        <button type="submit" disabled={!valid} className={styles.primary}>
          {t("calibration:setup.distribute")}
        </button>
      </div>
      <p className={styles.note}>
        {text !== "" && !valid
          ? total > ceiling
            ? t("calibration:setup.atMost", { max: ceiling })
            : t("calibration:setup.atLeast", { min: floor })
          : knownTotal !== null
            ? t("calibration:page.totalStep.fromWled", { count: knownTotal })
            : t("calibration:setup.countHint")}
      </p>
      <button type="button" onClick={onSkip} className={styles.skip}>
        {t("calibration:setup.skipTotal")}
      </button>
    </form>
  );
}
