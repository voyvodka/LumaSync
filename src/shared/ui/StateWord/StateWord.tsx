import type { ReactNode } from "react";

import { cx } from "@/shared/lib/cx";

import styles from "./StateWord.module.css";

export type StateTone = "live" | "ready" | "busy" | "warn" | "error" | "idle";

interface StateWordProps {
  tone: StateTone;
  /** Read out when it changes, unless the caller reads it out itself (`false`). */
  live?: boolean;
  testId?: string;
  children: ReactNode;
}

/** A device's state in a word, with a dot that says the same in colour. */
export function StateWord({ tone, live = true, testId, children }: StateWordProps) {
  return (
    <span
      className={styles.state}
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
      aria-hidden={live ? undefined : true}
      data-tone={tone}
      data-testid={live ? testId : undefined}
    >
      <span className={cx(styles.dot, styles[tone])} aria-hidden="true" />
      {children}
    </span>
  );
}
