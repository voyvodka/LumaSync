import { useState, type ReactNode } from "react";

import { cx } from "../cx";
import styles from "./SpinSwap.module.css";

interface SpinSwapProps<V extends string> {
  value: V;
  /** Which way the icon turns when `value` changes to the current one. */
  turn: (value: V) => "cw" | "ccw";
  render: (value: V) => ReactNode;
  className?: string;
}

/**
 * An icon that changes by turning: the old one spins away and the new one spins in, both the
 * same way. A mirror flip squashes an icon flat mid-way and reads as nothing happening.
 */
export function SpinSwap<V extends string>({ value, turn, render, className }: SpinSwapProps<V>) {
  const [state, setState] = useState({ value, prev: null as V | null, n: 0 });
  if (value !== state.value) setState({ value, prev: state.value, n: state.n + 1 });
  const n = state.n;
  return (
    <span className={cx(styles.box, turn(state.value) === "cw" ? styles.cw : styles.ccw, className)}>
      {state.prev !== null && (
        <span
          key={`out${n}`}
          aria-hidden
          className={cx(styles.icon, styles.out)}
          onAnimationEnd={() => setState((s) => (s.n === n ? { ...s, prev: null } : s))}
        >
          {render(state.prev)}
        </span>
      )}
      <span key={`in${n}`} className={cx(styles.icon, n > 0 && styles.in)}>
        {render(state.value)}
      </span>
    </span>
  );
}
