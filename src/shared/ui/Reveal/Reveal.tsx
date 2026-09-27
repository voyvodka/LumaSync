import { useEffect, useRef, useState, type ReactNode } from "react";

import { cx } from "../cx";
import styles from "./Reveal.module.css";

interface RevealProps {
  open: boolean;
  children: ReactNode;
  /** Grows in when it mounts open, for something that arrives rather than something the page opens on. */
  appear?: boolean;
  className?: string;
}

/**
 * Something a state brings and takes away — a note under a row, a row of its own. It grows to its
 * height and fades in, and closing shrinks it with the last content still inside, so the rows
 * below slide rather than jump. What the page opens on is already in place: no motion at mount.
 */
export function Reveal({ open, children, appear = false, className }: RevealProps) {
  // The content it closes with, for a caller that drops it the moment it closes. A caller that
  // keeps passing it is drawn live, so what closes is what is current (a list inside closes too).
  const kept = useRef<ReactNode>(children);
  if (children !== null && children !== undefined && children !== false) kept.current = children;
  const [shown, setShown] = useState(open && !appear);
  // Clipped only while it moves: at rest a focus ring at the row's edge must not be cut off.
  const [settled, setSettled] = useState(open && !appear);
  // Closed and done moving: what it held leaves with it.
  const [gone, setGone] = useState(!open);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      if (!open || !appear) return;
    }
    setSettled(false);
    if (!open) {
      setShown(false);
      const leave = setTimeout(() => setGone(true), 400);
      return () => clearTimeout(leave);
    }
    setGone(false);
    // A frame closed first, so an `appear` has a height to grow from.
    const frame = requestAnimationFrame(() => setShown(true));
    // An engine that does not transition grid rows sends no transitionend; nor does reduced motion.
    const settle = setTimeout(() => setSettled(true), 400);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
    };
  }, [open, appear]);

  return (
    <div
      className={cx(styles.reveal, shown && styles.open, shown && settled && styles.settled, className)}
      data-reveal=""
      data-open={shown}
      inert={!open || undefined}
      aria-hidden={!open || undefined}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") return;
        setSettled(open);
        if (!open) setGone(true);
      }}
    >
      <div className={styles.inner}>{gone ? null : kept.current}</div>
    </div>
  );
}
