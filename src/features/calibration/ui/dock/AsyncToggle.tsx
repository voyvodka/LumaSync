import { useRef, type ReactNode } from "react";

import { cx } from "@/shared/ui/cx";
import { StateSwap } from "@/shared/ui/StateSwap/StateSwap";
import styles from "./AsyncToggle.module.css";

interface AsyncToggleProps {
  on: boolean;
  /** Starting or stopping: the waiting face shows, in words — never a spinner. */
  waiting: boolean;
  /** Held by something else (a display switch): dimmed, presses ignored by the owner. */
  busy?: boolean;
  disabled?: boolean;
  /** The action a press would do now, for assistive tech. */
  label: string;
  faces: { idle: ReactNode; on: ReactNode; starting: ReactNode; stopping: ReactNode };
  onToggle: () => void;
  className?: string;
}

/**
 * An on/off action that takes a while, like a test pattern starting on a Hue bridge. Idle,
 * running and waiting faces share one fixed button and crossfade; the fill eases in with "on".
 */
export function AsyncToggle({ on, waiting, busy, disabled, label, faces, onToggle, className }: AsyncToggleProps) {
  // Fixed when the wait begins: as "on" arrives, "Starting…" fades out as it was instead of
  // turning into "Stopping…" on its way.
  const waitRef = useRef<"starting" | "stopping">("starting");
  if (waiting) waitRef.current = on ? "stopping" : "starting";
  return (
    <button
      type="button"
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-busy={waiting || undefined}
      aria-label={label}
      onClick={onToggle}
      className={cx(styles.toggle, on && styles.on, waiting && styles.waiting, className)}
    >
      <StateSwap
        state={waiting ? "wait" : on ? "on" : "idle"}
        faces={{ idle: faces.idle, on: faces.on, wait: waitRef.current === "stopping" ? faces.stopping : faces.starting }}
      />
    </button>
  );
}
