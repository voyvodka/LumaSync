import { useId, useRef, useState, type ReactNode } from "react";

import { Popover } from "../Popover/Popover";
import styles from "./InfoTip.module.css";

interface InfoTipProps {
  /** Names the button, e.g. "About Reduce motion". */
  label: string;
  /** A line or two in plain sentence case. */
  children: ReactNode;
}

/** The one ⓘ an explanation lives behind, so the screen itself shows only values and actions. */
export function InfoTip({ label, children }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className={styles.button}
      >
        <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 7.2v3.6" />
          <circle cx="8" cy="5" r=".35" fill="currentColor" />
        </svg>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} side="below" width={260} id={id} label={label} role="dialog">
        <p className={styles.text}>{children}</p>
      </Popover>
    </>
  );
}
