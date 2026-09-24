import type { ReactNode } from "react";

import { cx } from "./cx";

export type StatusPillTone = "ok" | "warn" | "error" | "streaming" | "idle";

interface StatusPillProps {
  tone: StatusPillTone;
  /** Always text: the tone's colour and dot never stand alone. */
  children: ReactNode;
  className?: string;
}

/** A device card's state chip. The dot shape per tone is in devices.css. */
export function StatusPill({ tone, children, className }: StatusPillProps) {
  return <span className={cx("lm-dcard-pill", `is-${tone}`, className)}>{children}</span>;
}
