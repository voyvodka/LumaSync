import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { NOTICE_SEVERITY_LABEL } from "./noticeModel";
import { NoticeRow } from "./NoticeRow";
import type { QueuedNotice, ShellNoticeQueue } from "./useShellNoticeQueue";

interface ShellNoticeSlotProps {
  /**
   * Both sit in flow at the top of the content, flush to its edges, so a
   * notice pushes the page down and never covers it. `compact` keeps a second
   * action for the expanded strip; `full` has room for it on the line.
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
 * Tracks whether a one-line message is cut by its ellipsis. Measures only
 * while the line is unwrapped — wrapped, it never overflows — so the answer
 * from before the toggle wrapped it keeps that toggle on screen to unwrap it.
 */
function useLineOverflow(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  content: string,
  setOverflowing: (overflowing: boolean) => void,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `content` is the trigger — a new message needs a new measurement
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !active) return;
    // Rounding can put scrollWidth a pixel past a line that fits.
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, active, content, setOverflowing]);
}

/**
 * The one place the shell's notices appear: the top notice as a single strip
 * line, and the rest behind a "+N" that expands them in place. See
 * docs/architecture/ui-and-shell.md.
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
  const messageRef = useRef<HTMLParagraphElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  // A cut sentence can expand on its own, so the whole of it is reachable
  // without a pointer to hover the tooltip.
  const canExpand = rest.length > 0 || overflowing;
  const shownExpanded = expanded && canExpand;
  useLineOverflow(messageRef, !shownExpanded, top ? `${top.key}\u0001${top.notice.message}` : "", setOverflowing);

  const reserve = top === undefined && holdSpace && occupied;
  if (top === undefined && !reserve) return null;

  const toggle = {
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
        <NoticeRow
          key={top.key}
          entry={top}
          wrapped={shownExpanded}
          showSecondary={!compact || shownExpanded}
          labelDismiss={!compact}
          onDismiss={handleDismiss}
          toggle={canExpand ? toggle : undefined}
          messageRef={messageRef}
          overflowing={overflowing}
        />
      )}
      {shownExpanded &&
        rest.map((entry) => (
          <NoticeRow
            key={entry.key}
            entry={entry}
            wrapped
            showSecondary
            labelDismiss={!compact}
            onDismiss={handleDismiss}
          />
        ))}
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
      {notice ? `${t(NOTICE_SEVERITY_LABEL[notice.severity])}: ${notice.message}` : ""}
    </div>
  );
}
