import type { Ref } from "react";
import { useTranslation } from "react-i18next";

import { IconChevronDown, IconClose } from "@/shared/ui/icons";

import { NOTICE_SEVERITY_LABEL, type NoticeAction } from "./noticeModel";
import type { QueuedNotice } from "./useShellNoticeQueue";

export interface NoticeRowToggle {
  /** Notices behind this one. */
  count: number;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
}

interface NoticeRowProps {
  entry: QueuedNotice;
  /** Expanded, the sentence wraps; otherwise it stays on one line and ends in an ellipsis. */
  wrapped: boolean;
  showSecondary: boolean;
  onDismiss: (entry: QueuedNotice) => void;
  toggle?: NoticeRowToggle;
  messageRef?: Ref<HTMLParagraphElement>;
  /** The line is cut: the native tooltip carries the whole sentence. */
  overflowing?: boolean;
}

function ActionLink({ action, secondary = false }: { action: NoticeAction; secondary?: boolean }) {
  return (
    <button
      type="button"
      className={secondary ? "lm-notice-action is-secondary" : "lm-notice-action"}
      onClick={action.onClick}
      disabled={action.pending}
      aria-busy={action.pending || undefined}
      data-testid={action.testId}
    >
      {action.label}
      {action.navigates && (
        <span className="lm-notice-arrow" aria-hidden="true">
          →
        </span>
      )}
    </button>
  );
}

/** One notice as one strip line. Carries no live region — the shell has exactly one. */
export function NoticeRow({
  entry,
  wrapped,
  showSecondary,
  onDismiss,
  toggle,
  messageRef,
  overflowing = false,
}: NoticeRowProps) {
  const { t } = useTranslation();
  const { notice } = entry;
  const toggleLabel = toggle
    ? toggle.expanded
      ? t("shell:notices.showLess")
      : toggle.count > 0
        ? t("shell:notices.showMore", { count: toggle.count })
        : t("shell:notices.showDetails")
    : "";

  return (
    <div
      className={`lm-notice is-${notice.severity}${wrapped ? " is-wrapped" : ""}`}
      data-testid={notice.testId}
      data-notice-id={notice.id}
      data-kind={notice.kind}
      {...notice.data}
    >
      <span className="lm-notice-dot" aria-hidden="true" />
      <p ref={messageRef} className="lm-notice-message" title={overflowing && !wrapped ? notice.message : undefined}>
        <span className="sr-only">{t(NOTICE_SEVERITY_LABEL[notice.severity])}: </span>
        {notice.step && <span className="lm-notice-step">{notice.step}</span>}
        {notice.message}
      </p>
      {notice.action && <ActionLink action={notice.action} />}
      {showSecondary && notice.secondaryAction && <ActionLink action={notice.secondaryAction} secondary />}
      {notice.dismissible && (
        <button
          type="button"
          className="lm-notice-icon-btn"
          onClick={() => onDismiss(entry)}
          aria-label={t("shell:notices.dismiss")}
          title={t("shell:notices.dismiss")}
          data-testid="notice-dismiss"
        >
          <IconClose />
        </button>
      )}
      {toggle && (
        <button
          type="button"
          className={`lm-notice-icon-btn lm-notice-toggle${toggle.expanded ? " is-expanded" : ""}`}
          aria-expanded={toggle.expanded}
          aria-controls={toggle.controls}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={toggle.onToggle}
          data-testid="notice-toggle"
        >
          {toggle.count > 0 && !toggle.expanded ? (
            <span className="lm-notice-count">{t("shell:notices.moreBadge", { count: toggle.count })}</span>
          ) : (
            <IconChevronDown />
          )}
        </button>
      )}
    </div>
  );
}
