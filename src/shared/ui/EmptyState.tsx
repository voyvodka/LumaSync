import type { ReactNode } from "react";

import { cx } from "./cx";

interface EmptyStateProps {
  title?: string;
  body: ReactNode;
  /** One next step, e.g. a scan or a deep link — never a dead end. */
  action?: ReactNode;
  className?: string;
}

/** The dashed placeholder a list shows when it has nothing to list. */
export function EmptyState({ title, body, action, className }: EmptyStateProps) {
  return (
    <div className={cx("lm-empty", className)}>
      {title && <h3>{title}</h3>}
      <p>{body}</p>
      {action && <div className="lm-empty-action">{action}</div>}
    </div>
  );
}
