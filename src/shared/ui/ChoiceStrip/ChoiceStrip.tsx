import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { cx } from "../cx";
import { Segmented } from "../Segmented";
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
  const [thumb, setThumb] = useState<{ left: number; right: number; toLeft: boolean } | null>(null);
  // The first placement lands without travel: the page opens with the fill already on its value.
  const [placed, setPlaced] = useState(false);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    const measure = () => {
      if (value === null) {
        setThumb(null);
        return;
      }
      const checked = strip.querySelector<HTMLElement>('[aria-checked="true"]');
      const group = checked?.offsetParent as HTMLElement | null | undefined;
      if (!checked || !group) {
        setThumb(null);
        return;
      }
      const left = group.offsetLeft + checked.offsetLeft;
      const right = strip.clientWidth - left - checked.offsetWidth;
      setThumb((previous) => ({ left, right, toLeft: previous ? left < previous.left : false }));
    };
    measure();
    // A language switch changes the labels' widths under the fill.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(strip);
    return () => observer?.disconnect();
  }, [value]);

  useEffect(() => {
    if (thumb && !placed) {
      const frame = requestAnimationFrame(() => setPlaced(true));
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [thumb, placed]);

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
