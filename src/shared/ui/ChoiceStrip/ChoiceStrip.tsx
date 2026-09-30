import { useRef } from "react";

import { cx } from "@/shared/lib/cx";
import { useChoiceThumb } from "@/shared/lib/useChoiceThumb";
import { Segmented } from "../Segmented/Segmented";
import styles from "./ChoiceStrip.module.css";

/** A few named values side by side, with one fill that travels to the chosen one. */
export function ChoiceStrip({
  label,
  value,
  options,
  onChange,
  testIdPrefix = "choice-",
}: {
  label: string;
  value: string | null;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  /** Each option's test id is this plus its value. */
  testIdPrefix?: string;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const { thumb, placed } = useChoiceThumb(stripRef, value);

  return (
    <div ref={stripRef} className={styles.strip}>
      {thumb && (
        <span
          className={cx(styles.thumb, placed && styles.moving, thumb.toLeft ? styles.toLeft : styles.toRight)}
          style={{ left: thumb.left, right: thumb.right }}
          aria-hidden="true"
        />
      )}
      <Segmented
        className={styles.group}
        itemClassName={styles.item}
        ariaLabel={label}
        value={value}
        onChange={onChange}
        options={options.map((o) => ({ value: o.value, label: o.label, testId: `${testIdPrefix}${o.value}` }))}
      />
    </div>
  );
}
