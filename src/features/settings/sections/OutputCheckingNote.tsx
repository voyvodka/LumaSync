import { useTranslation } from "react-i18next";

/** Stands in for the "no reachable output" banner while a paired bridge's first
 * probe is in flight, so the dimmed mode buttons are not left unexplained. */
export function OutputCheckingNote() {
  const { t } = useTranslation();
  return (
    <div className="lm-output-checking" role="status" aria-live="polite" data-testid="output-checking">
      <span className="lm-output-checking-dot" aria-hidden="true" />
      <span>{t("common:output.checking")}</span>
    </div>
  );
}
