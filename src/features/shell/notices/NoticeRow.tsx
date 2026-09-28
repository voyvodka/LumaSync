import type { Ref } from "react";
import { useTranslation } from "react-i18next";

import { IconChevronDown, IconClose } from "@/shared/ui/icons";

import { NOTICE_SEVERITY_LABEL, type NoticeAction } from "./noticeModel";
import styles from "./Notices.module.css";
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
  /**
   * A named dismiss (`dismissLabel`) may be spelled out as text. Full mode
   * only: at 320 px even the expanded strip squeezed the sentence into a
   * column one word wide, so compact keeps the × with the name as its label.
   */
  labelDismiss?: boolean;
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
      className={secondary ? `${styles.action} ${styles.secondary}` : styles.action}
      data-secondary={secondary || undefined}
      onClick={action.onClick}
      disabled={action.pending}
      aria-busy={action.pending || undefined}
      data-testid={action.testId}
    >
      {action.label}
      {action.navigates && (
        <span className={styles.arrow} aria-hidden="true" data-arrow>
          ›
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
  labelDismiss = false,
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
      className={[styles.notice, styles[notice.severity], wrapped && styles.wrapped].filter(Boolean).join(" ")}
      data-testid={notice.testId}
      data-notice-id={notice.id}
      data-wrapped={wrapped || undefined}
      data-kind={notice.kind}
      {...notice.data}
    >
      <span className={styles.dot} aria-hidden="true" />
      <p
        ref={messageRef}
        className={styles.message}
        title={overflowing && !wrapped ? notice.message : undefined}
        data-notice-message
      >
        <span className="sr-only">{t(NOTICE_SEVERITY_LABEL[notice.severity])}: </span>
        {notice.step && <span className={styles.step}>{notice.step}</span>}
        {notice.message}
      </p>
      {notice.action && <ActionLink action={notice.action} />}
      {showSecondary && notice.secondaryAction && <ActionLink action={notice.secondaryAction} secondary />}
      {notice.dismissible &&
        (notice.dismissLabel && labelDismiss ? (
          <button
            type="button"
            className={`${styles.action} ${styles.secondary}`}
            onClick={() => onDismiss(entry)}
            data-testid="notice-dismiss"
          >
            {notice.dismissLabel}
          </button>
        ) : (
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => onDismiss(entry)}
            aria-label={notice.dismissLabel ?? t("shell:notices.dismiss")}
            title={notice.dismissLabel ?? t("shell:notices.dismiss")}
            data-testid="notice-dismiss"
          >
            <IconClose />
          </button>
        ))}
      {toggle && (
        <button
          type="button"
          className={toggle.expanded ? `${styles.iconButton} ${styles.expanded}` : styles.iconButton}
          aria-expanded={toggle.expanded}
          aria-controls={toggle.controls}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={toggle.onToggle}
          data-testid="notice-toggle"
        >
          {toggle.count > 0 && !toggle.expanded ? (
            <span className={styles.count}>{t("shell:notices.moreBadge", { count: toggle.count })}</span>
          ) : (
            <IconChevronDown />
          )}
        </button>
      )}
    </div>
  );
}
