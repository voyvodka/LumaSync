import type { ReactNode } from "react";

import { cx } from "@/shared/lib/cx";
import { Segmented, type SegmentedOption } from "@/shared/ui/Segmented/Segmented";
import styles from "./Stage.module.css";

/**
 * The stage's language: one quiet surface, no card inside it, groups set apart by space. A mode's
 * controls are `StageGrid` cells (two columns where there is room) and `StageRow`s (a name with its
 * control on the same line).
 */
export function Stage({
  children,
  className,
  testId,
  dense = false,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
  /** The compact window's stage: less edge, less gap. */
  dense?: boolean;
}) {
  return (
    <section className={cx(styles.stage, className)} data-testid={testId} data-dense={dense || undefined}>
      {children}
    </section>
  );
}

export function StageGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(styles.grid, className)}>{children}</div>;
}

export function StageRow({
  label,
  value,
  children,
  className,
}: {
  label: ReactNode;
  value?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(styles.row, className)}>
      <span className={styles.rowLabel}>{label}</span>
      {value !== undefined && <span className={styles.rowValue}>{value}</span>}
      {children !== undefined && <span className={styles.rowControl}>{children}</span>}
    </div>
  );
}

/** A quiet line in the stage: what a mode is doing when it has nothing to set. */
export function StageNote({ children }: { children: ReactNode }) {
  return <p className={styles.note}>{children}</p>;
}

/** A choice of a few named values in the stage's look (`Segmented` underneath). */
export function StageChoice<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled,
  className,
}: {
  options: readonly SegmentedOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Segmented
      options={options}
      value={value}
      onChange={onChange}
      ariaLabel={ariaLabel}
      disabled={disabled}
      className={cx(styles.choice, className)}
      itemClassName={styles.choiceItem}
    />
  );
}
