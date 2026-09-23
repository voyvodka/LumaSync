import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { NoticeCard } from "./NoticeCard";
import { NOTICE_SEVERITY_LABEL } from "./noticeModel";
import type { QueuedNotice, ShellNoticeQueue } from "./useShellNoticeQueue";

interface ShellNoticeSlotProps {
  /**
   * Both sit in flow at the top of the content, so a notice pushes the page
   * down and never covers it. `compact` shows a one-line headline; `full`
   * shows the body, with the actions at the card's right edge.
   */
  variant: "compact" | "full";
  queue: ShellNoticeQueue;
  /** A modal owns the screen: the slot stays where it is, beneath it and unreachable. */
  suppressed: boolean;
  /**
   * Keeps the slot's height while another notice is still due, so the one
   * leaving does not pull the controls up just before the next pushes them
   * back down.
   */
  holdSpace?: boolean;
}

/**
 * The one place the shell's notices appear: the top notice, and the rest
 * behind a "+N" that expands in place. See docs/architecture/ui-and-shell.md.
 */
export function ShellNoticeSlot({
  variant,
  queue,
  suppressed,
  holdSpace = false,
}: ShellNoticeSlotProps) {
  const { t } = useTranslation();
  const slotId = useId();
  const { entries, expanded, setExpanded, dismiss, holdProps, releaseHold } = queue;
  const [top, ...rest] = entries;

  const sectionRef = useRef<HTMLElement | null>(null);
  const [occupied, setOccupied] = useState(false);
  if (top !== undefined && !occupied) setOccupied(true);

  // Unmounting under the pointer never reports a pointer leave.
  useEffect(() => releaseHold, [releaseHold]);

  const compact = variant === "compact";
  const reserve = top === undefined && holdSpace && occupied;
  if (top === undefined && !reserve) return null;

  // Compact's headline hides the body, so even a lone notice can expand.
  const canExpand = rest.length > 0 || (compact && Boolean(top?.notice.body));
  const shownExpanded = expanded && canExpand;
  const toggle = {
    variant: compact ? ("icon" as const) : ("text" as const),
    count: rest.length,
    expanded: shownExpanded,
    controls: slotId,
    onToggle: () => setExpanded(!shownExpanded),
  };

  // The × a keyboard user pressed is gone with its card; the slot keeps the
  // focus instead of dropping it to the top of the document.
  const handleDismiss = (entry: QueuedNotice) => {
    const hadFocus = sectionRef.current?.contains(document.activeElement) ?? false;
    dismiss(entry);
    if (hadFocus) requestAnimationFrame(() => sectionRef.current?.focus());
  };

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      id={slotId}
      className={compact ? "lm-notice-slot" : "lm-notice-slot is-wide"}
      aria-label={t("shell:notices.regionLabel")}
      data-testid="shell-notice-slot"
      data-variant={variant}
      // The whole queue, including what sits behind "+N" — for tests and the e2e audit.
      data-queue={entries.map((entry) => entry.notice.id).join(" ")}
      data-suppressed={suppressed || undefined}
      inert={suppressed || undefined}
      {...holdProps}
    >
      {top === undefined ? (
        <div className="lm-notice-placeholder" aria-hidden="true" data-testid="notice-placeholder" />
      ) : (
        <NoticeCard
          key={top.key}
          entry={top}
          layout={compact && !shownExpanded ? "headline" : "detail"}
          onDismiss={handleDismiss}
          toggle={canExpand ? toggle : undefined}
        />
      )}
      {shownExpanded &&
        rest.map((entry) => <NoticeCard key={entry.key} entry={entry} layout="detail" onDismiss={handleDismiss} />)}
    </section>
  );
}

/**
 * The shell's single live region. Mounted once, outside the slot, so a
 * compact↔full switch or an empty queue never tears it down mid-sentence.
 */
export function ShellNoticeAnnouncer({ queue }: { queue: Pick<ShellNoticeQueue, "announced"> }) {
  const { t } = useTranslation();
  const notice = queue.announced?.notice;
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="shell-notice-announcer">
      {notice ? `${t(NOTICE_SEVERITY_LABEL[notice.severity])}: ${notice.title}. ${notice.body ?? ""}` : ""}
    </div>
  );
}
