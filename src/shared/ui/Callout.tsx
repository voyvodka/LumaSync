import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "./cx";

export type CalloutTone = "error" | "warning" | "info" | "ok";

const TONE_LABEL = {
  error: "common:callout.tone.error",
  warning: "common:callout.tone.warning",
  info: "common:callout.tone.info",
  ok: "common:callout.tone.ok",
} as const satisfies Record<CalloutTone, string>;

export interface CalloutAction {
  label: string;
  onClick: () => void;
  pending?: boolean;
  testId?: string;
}

interface CalloutProps {
  tone: CalloutTone;
  /** One sentence. */
  children: ReactNode;
  action?: CalloutAction;
  /**
   * An error is an alert and anything else a polite status. Off inside a
   * container that is already the live region, so a list is not read twice.
   */
  announce?: boolean;
  className?: string;
  testId?: string;
}

/**
 * Inline feedback under the control it is about, in the notice strip's
 * vocabulary: a tone dot whose shape survives forced colours, one sentence,
 * and at most one text-link action. No card, no side bar.
 */
export function Callout({ tone, children, action, announce = true, className, testId }: CalloutProps) {
  const { t } = useTranslation();
  const role = announce ? (tone === "error" ? "alert" : "status") : undefined;
  return (
    <div className={cx("lm-callout", `is-${tone}`, className)} role={role} data-testid={testId}>
      <span className="lm-callout-dot" aria-hidden="true" />
      <p className="lm-callout-message">
        <span className="sr-only">{t(TONE_LABEL[tone])}: </span>
        {children}
      </p>
      {action && (
        <button
          type="button"
          className="lm-callout-action"
          onClick={action.onClick}
          disabled={action.pending}
          aria-busy={action.pending || undefined}
          data-testid={action.testId}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
