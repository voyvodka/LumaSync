import type { ComponentPropsWithRef, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "@/shared/ui/cx";
import { InfoTip } from "@/shared/ui/InfoTip/InfoTip";
import styles from "./SettingRow.module.css";

interface SettingRowProps {
  label: string;
  /** What the setting does, behind an ⓘ beside its name. */
  hint?: string;
  control?: ReactNode;
  /** A result or a failure that belongs to this row, under it. */
  children?: ReactNode;
  testId?: string;
}

/** One setting: its name, its control on the right, and whatever it has to say under it. */
export function SettingRow({ label, hint, control, children, testId }: SettingRowProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.row} data-testid={testId}>
      <div className={styles.line}>
        <span className={styles.name}>{label}</span>
        {hint && <InfoTip label={t("settings:hintFor", { label })}>{hint}</InfoTip>}
        <span className={styles.control}>{control}</span>
      </div>
      {children}
    </div>
  );
}

/** A quiet secondary action: grey at rest, warm on hover. */
export function RowButton({ className, type = "button", ...rest }: ComponentPropsWithRef<"button">) {
  return <button type={type} className={cx(styles.action, className)} {...rest} />;
}

interface RowLinkProps {
  href: string;
  label: string;
  testId: string;
}

/** Opens in the system browser through the opener plugin's link handler. */
export function RowLink({ href, label, testId }: RowLinkProps) {
  const { t } = useTranslation();
  return (
    <a className={styles.action} href={href} target="_blank" rel="noreferrer noopener" data-testid={testId}>
      {label}
      <span aria-hidden="true">↗</span>
      <span className="sr-only"> ({t("settings:help.opensInBrowser")})</span>
    </a>
  );
}

/** A line under the row: a result read once (`status`) or a failure (`error`). */
export function RowNote({ tone, children, testId }: { tone: "status" | "error"; children: ReactNode; testId?: string }) {
  return (
    <p
      className={cx(styles.note, tone === "error" && styles.error)}
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? undefined : "polite"}
      data-testid={testId}
    >
      {children}
    </p>
  );
}

export const rowStyles = styles;
