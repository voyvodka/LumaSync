import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cx } from "../cx";
import styles from "./PageSwap.module.css";

/** How the new content arrives: from the side a step went, dropping from a list above, or in place. */
export type PageWay = "next" | "prev" | "drop" | "fade";

interface PageSwapProps {
  /** What the content is; a new id pages, the same id with new children just updates. */
  id: string;
  /** Read when `id` changes. */
  way: PageWay;
  children: ReactNode;
  className?: string;
}

/**
 * Content that pages when its id changes. The old content leaves the way it came from while the
 * new one enters a beat later, far enough apart that the two never pile up; both sit in one fixed,
 * edge-masked box, so nothing around it moves. Direction is a class, not a CSS variable: WebKit is
 * unreliable with variables inside keyframes.
 */
export function PageSwap({ id, way, children, className }: PageSwapProps) {
  const [state, setState] = useState({ id, prev: null as ReactNode, way, n: 0 });
  // What was on screen at the last commit: the content that has to leave when `id` moves on.
  const shownRef = useRef<ReactNode>(children);
  if (id !== state.id) setState({ id, prev: shownRef.current, way, n: state.n + 1 });
  useLayoutEffect(() => {
    shownRef.current = children;
  });
  const n = state.n;
  return (
    <span className={cx(styles.box, styles[state.way], state.prev !== null && styles.passing, className)}>
      {state.prev !== null && (
        <span
          key={`out${n}`}
          aria-hidden
          className={cx(styles.page, styles.out)}
          onAnimationEnd={() => setState((s) => (s.n === n ? { ...s, prev: null } : s))}
        >
          {state.prev}
        </span>
      )}
      <span key={`in${n}`} className={cx(styles.page, n > 0 && styles.in)}>
        {children}
      </span>
    </span>
  );
}
