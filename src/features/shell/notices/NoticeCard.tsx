import { useTranslation } from "react-i18next";

import { IconChevronDown, IconClose, IconError, IconInfoAlt, IconWarning } from "@/shared/ui/icons";

import { NOTICE_SEVERITY, NOTICE_SEVERITY_LABEL, type NoticeAction, type NoticeSeverity } from "./noticeModel";
import type { QueuedNotice } from "./useShellNoticeQueue";

function SeverityGlyph({ severity }: { severity: NoticeSeverity }) {
  if (severity === NOTICE_SEVERITY.ERROR) return <IconError />;
  if (severity === NOTICE_SEVERITY.WARNING) return <IconWarning />;
  return <IconInfoAlt />;
}

export interface NoticeCardToggle {
  /** `icon` sits at the card's edge (compact); `text` under the body (full). */
  variant: "icon" | "text";
  /** Notices behind this one. */
  count: number;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
}

interface NoticeCardProps {
  entry: QueuedNotice;
  /** `headline` shows the title alone (the compact slot); `detail` adds the body. */
  layout: "headline" | "detail";
  onDismiss: (entry: QueuedNotice) => void;
  toggle?: NoticeCardToggle;
}

function ActionButton({ action, secondary = false }: { action: NoticeAction; secondary?: boolean }) {
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
    </button>
  );
}

/** One notice. Carries no live region — the shell has exactly one. */
export function NoticeCard({ entry, layout, onDismiss, toggle }: NoticeCardProps) {
  const { t } = useTranslation();
  const { notice } = entry;
  const headline = layout === "headline";
  const toggleLabel = toggle
    ? toggle.expanded
      ? t("shell:notices.showLess")
      : toggle.count > 0
        ? t("shell:notices.showMore", { count: toggle.count })
        : t("shell:notices.showDetails")
    : "";
  const showMore = toggle?.variant === "text" && toggle.count > 0;
  const actionButton = notice.action && <ActionButton action={notice.action} />;
  // Rendered with the body only: the headline has room for one button.
  const secondaryButton = notice.secondaryAction && <ActionButton action={notice.secondaryAction} secondary />;

  return (
    <div
      className={`lm-notice is-${notice.severity} ${headline ? "is-headline" : "is-detail"}`}
      data-testid={notice.testId}
      data-notice-id={notice.id}
      data-kind={notice.kind}
      {...notice.data}
    >
      <span className="lm-notice-glyph" aria-hidden="true">
        <SeverityGlyph severity={notice.severity} />
      </span>
      <div className="lm-notice-text">
        <p className="lm-notice-title">
          <span className="sr-only">{t(NOTICE_SEVERITY_LABEL[notice.severity])}: </span>
          {notice.step && <span className="lm-notice-step">{notice.step}</span>}
          {notice.title}
        </p>
        {/* The headline hides the body from sight only; a screen reader still gets it. */}
        {notice.body && <p className={headline ? "sr-only" : "lm-notice-body"}>{notice.body}</p>}
        {/* Under the body in detail, so the body gets the card's full width. */}
        {!headline && (actionButton || secondaryButton || showMore) && (
          <div className="lm-notice-actions">
            {actionButton}
            {secondaryButton}
            {showMore && toggle && (
              <button
                type="button"
                className="lm-notice-more"
                aria-expanded={toggle.expanded}
                aria-controls={toggle.controls}
                onClick={toggle.onToggle}
              >
                {toggle.expanded ? t("shell:notices.showLess") : t("shell:notices.moreCount", { count: toggle.count })}
              </button>
            )}
          </div>
        )}
      </div>
      {headline && actionButton}
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
      {toggle?.variant === "icon" && (
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
