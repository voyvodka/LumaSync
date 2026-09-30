import { useRef, type ReactNode } from "react";

import { cx } from "@/shared/lib/cx";
import { useChoiceThumb } from "@/shared/lib/useChoiceThumb";
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
    <section
      className={cx(styles.stage, className)}
      data-testid={testId}
      data-dense={dense || undefined}
    >
      {children}
    </section>
  );
}

export function StageGrid({
  children,
  className,
  lead = false,
}: {
  children: ReactNode;
  className?: string;
  /** The first cell is a fixed-size control: it keeps its width and the second takes the rest. */
  lead?: boolean;
}) {
  return (
    <div className={cx(styles.grid, className)} data-lead={lead || undefined}>
      {children}
    </div>
  );
}

export function StageRow({
  label,
  info,
  value,
  children,
  className,
}: {
  label: ReactNode;
  /** An `InfoTip` beside the name, outside its clipped box so its hit area and ring stay whole. */
  info?: ReactNode;
  value?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(styles.row, className)}>
      <span className={styles.rowLabel}>{label}</span>
      {info !== undefined && <span className={styles.rowInfo}>{info}</span>}
      {value !== undefined && <span className={styles.rowValue}>{value}</span>}
      {children !== undefined && <span className={styles.rowControl}>{children}</span>}
    </div>
  );
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
  // One fill travels to the chosen value, as in `ChoiceStrip`: a switch that only recoloured two
  // buttons read as nothing having happened.
  const stripRef = useRef<HTMLDivElement>(null);
  const { thumb, placed } = useChoiceThumb(stripRef, value);
  return (
    <div ref={stripRef} className={cx(styles.choice, className)} data-thumb={thumb ? true : undefined}>
      {thumb && (
        <span
          className={cx(styles.choiceThumb, placed && styles.choiceMoving, thumb.toLeft ? styles.choiceToLeft : styles.choiceToRight)}
          style={{ left: thumb.left, right: thumb.right }}
          aria-hidden="true"
        />
      )}
      <Segmented
        options={options}
        value={value}
        onChange={onChange}
        ariaLabel={ariaLabel}
        disabled={disabled}
        className={styles.choiceGroup}
        itemClassName={styles.choiceItem}
      />
    </div>
  );
}
