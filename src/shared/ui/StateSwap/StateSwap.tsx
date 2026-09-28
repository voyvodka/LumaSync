import type { ReactNode } from "react";

import { cx } from "@/shared/lib/cx";
import styles from "./StateSwap.module.css";

interface StateSwapProps<K extends string> {
  /** The face on show. */
  state: K;
  /** Every face, stacked in one box and kept mounted: a change is a crossfade, never a remount. */
  faces: Record<K, ReactNode>;
  /** Sizes the box to its widest face, for a box with no fixed size of its own. */
  fit?: boolean;
  className?: string;
}

/**
 * Stacked states in one fixed box — a toggle's idle / running / waiting, a save's
 * "Saved" / "Save". The face leaving fades evenly while the one arriving rises a few pixels
 * in a beat later, so the box is never empty mid-swap and nothing around it moves. Faces not on
 * show are `inert` (out of the tab order) and `aria-hidden` (out of the accessibility tree where
 * `inert` is not honoured), interactive or not.
 */
export function StateSwap<K extends string>({ state, faces, fit = false, className }: StateSwapProps<K>) {
  const keys = Object.keys(faces) as K[];
  return (
    <span className={cx(styles.swap, fit && styles.fit, className)}>
      {/* Every face over one cell, unseen: the box takes the widest, in any language. */}
      {fit && (
        <span className={styles.sizer} aria-hidden="true">
          {keys.map((key) => (
            <span key={key}>{faces[key]}</span>
          ))}
        </span>
      )}
      {keys.map((key) => (
        <span
          key={key}
          inert={key !== state || undefined}
          aria-hidden={key !== state || undefined}
          className={cx(styles.face, key === state && styles.shown)}
        >
          {faces[key]}
        </span>
      ))}
    </span>
  );
}
