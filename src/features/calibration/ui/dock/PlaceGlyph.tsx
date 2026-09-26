import { gapRightCount, type LedRef, type StripShape } from "../../model/startPoint";
import { cx } from "@/shared/ui/cx";
import styles from "./PlaceGlyph.module.css";

/** Where LED #1 sits on the screen, 0..1 each way; the bottom leaves the stand gap like the canvas does. */
function spotOf(shape: StripShape, led: LedRef): { x: number; y: number } {
  const n = Math.max(1, shape.counts[led.edge]);
  const t = (led.k + 0.5) / n;
  switch (led.edge) {
    case "top":
      return { x: t, y: 0 };
    case "right":
      return { x: 1, y: t };
    case "left":
      return { x: 0, y: 1 - t };
    case "bottom": {
      const gap = shape.gap > 0 ? shape.gap : 0;
      const skip = gap > 0 && led.k >= gapRightCount(shape.counts.bottom) ? gap : 0;
      return { x: 1 - (led.k + skip + 0.5) / (n + gap), y: 1 };
    }
  }
}

/**
 * A small screen with LED #1 marked on it. Its colours come from `--place-*` custom properties, so
 * a list can dim or warm a row's glyph without reaching into this component.
 */
export function PlaceGlyph({ shape, led, land }: { shape: StripShape; led: LedRef; land?: boolean }) {
  const { x, y } = spotOf(shape, led);
  const cx0 = 3 + x * 14;
  const cy0 = 3 + y * 9;
  return (
    <svg viewBox="0 0 20 15" aria-hidden className={styles.glyph}>
      <rect x="3" y="3" width="14" height="9" rx="1.5" className={styles.screen} />
      {shape.gap > 0 && shape.counts.bottom > 0 && <path d="M8.5 12h3" className={styles.gap} />}
      <circle cx={cx0} cy={cy0} r="2.8" className={styles.ring} />
      <circle cx={cx0} cy={cy0} r="1.2" className={cx(styles.dot, land && styles.land)} />
    </svg>
  );
}
