import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from "react";

import { orderNotices, type ShellNotice } from "./noticeModel";

/** An event first seen while the queue was held back gets at least this long on screen. */
export const NOTICE_MIN_VISIBLE_MS = 4_000;
/** How long an expired event lingers after the pointer or focus leaves it. */
export const NOTICE_RELEASE_GRACE_MS = 1_500;

/** A notice plus the occurrence it belongs to; a × hides one occurrence, not the id. */
export interface QueuedNotice {
  notice: ShellNotice;
  key: string;
}

interface Retained {
  entry: QueuedNotice;
  /** `null` while held; otherwise when it leaves. */
  releaseAt: number | null;
}

export interface ShellNoticeHoldProps {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocus: () => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
}

export interface ShellNoticeQueue {
  /** Queue order, highest priority first. */
  entries: QueuedNotice[];
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  dismiss: (entry: QueuedNotice) => void;
  /** Spread on the rendered surface: pointer or focus inside holds every expiring event. */
  holdProps: ShellNoticeHoldProps;
  /** For a surface that unmounts under the pointer, which then never reports leaving. */
  releaseHold: () => void;
  /** The newest top notice the live region should speak. */
  announced: QueuedNotice | null;
}

const sourceIds = new WeakMap<object, number>();
let nextSourceId = 0;

/** Objects by identity, so a re-raised failure with the same copy is still a new occurrence. */
function sourceToken(source: unknown): string {
  if ((typeof source === "object" && source !== null) || typeof source === "function") {
    let id = sourceIds.get(source);
    if (id === undefined) {
      id = nextSourceId++;
      sourceIds.set(source, id);
    }
    return `#${id}`;
  }
  return `${typeof source}:${String(source)}`;
}

function noticeSignature(notice: ShellNotice): string {
  return [
    notice.id,
    notice.tier,
    notice.severity,
    notice.kind,
    notice.title,
    notice.body ?? "",
    notice.step ?? "",
    notice.action?.label ?? "",
    notice.action?.pending ? "1" : "0",
    notice.secondaryAction?.label ?? "",
    notice.secondaryAction?.pending ? "1" : "0",
    notice.dismissible ? "1" : "0",
    sourceToken(notice.source),
  ].join("\u0001");
}

export interface ShellNoticeQueueOptions {
  /** A modal owns the screen: nothing here is shown, spoken, or allowed to expire. */
  suppressed: boolean;
}

/**
 * Turns the builder's list into what the slot shows. Sources keep their own
 * timers; the queue only adds what a timer cannot know — that the user is
 * reading the notice, that a modal hid it, or that they dismissed it.
 */
export function useShellNoticeQueue(
  candidates: ShellNotice[],
  { suppressed }: ShellNoticeQueueOptions,
): ShellNoticeQueue {
  const occurrencesRef = useRef(new Map<string, { n: number; source: unknown; present: boolean }>());

  // Keyed on content, not on the array: callers rebuild the list on renders
  // where nothing changed, and the retention below sets state whenever `live`
  // moves — keyed on identity, that would never settle.
  const signature = candidates.map(noticeSignature).join("\u0002");
  // Idempotent per input, so a StrictMode double render cannot count twice.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `signature`, not on the array callers rebuild
  const live = useMemo<QueuedNotice[]>(() => {
    const occurrences = occurrencesRef.current;
    const liveIds = new Set<string>(candidates.map((notice) => notice.id));
    for (const [id, occurrence] of occurrences) {
      if (!liveIds.has(id)) occurrence.present = false;
    }
    return candidates.map((notice) => {
      const previous = occurrences.get(notice.id);
      if (previous === undefined) {
        occurrences.set(notice.id, { n: 1, source: notice.source, present: true });
        return { notice, key: `${notice.id}#1` };
      }
      if (!previous.present || !Object.is(previous.source, notice.source)) {
        previous.n += 1;
        previous.source = notice.source;
        previous.present = true;
      }
      return { notice, key: `${notice.id}#${previous.n}` };
    });
  }, [signature]);

  const [held, setHeld] = useState(false);
  const holding = held || suppressed;
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [retained, setRetained] = useState<ReadonlyMap<string, Retained>>(() => new Map());
  const [expanded, setExpandedState] = useState(false);
  const seenRef = useRef(new Set<string>());

  // An event whose source let go while the user was reading it, or while a
  // modal hid it, is kept. Decided during render so the card never unmounts
  // for a frame — that would drop the focus a keyboard user had on its ×.
  const [previousLive, setPreviousLive] = useState(live);
  // This render already has to see what it just decided to keep.
  let currentRetained = retained;
  if (previousLive !== live) {
    setPreviousLive(live);
    const liveKeys = new Set(live.map((entry) => entry.key));
    const liveIds = new Set<string>(live.map((entry) => entry.notice.id));
    let next: Map<string, Retained> | null = null;
    for (const entry of previousLive) {
      if (entry.notice.kind !== "event" || liveKeys.has(entry.key) || dismissed.has(entry.key)) continue;
      // A fresh occurrence of the same id stands in for the old one.
      if (liveIds.has(entry.notice.id)) continue;
      if (holding || !seenRef.current.has(entry.key)) {
        next ??= new Map(retained);
        next.set(entry.key, { entry, releaseAt: null });
      }
    }
    for (const [key, kept] of retained) {
      if (liveIds.has(kept.entry.notice.id)) {
        next ??= new Map(retained);
        next.delete(key);
      }
    }
    if (next !== null) {
      setRetained(next);
      currentRetained = next;
    }
  }

  // Kept events wait while anything holds them. Once nothing does, the unseen
  // ones get a fair look and the ones the user already read a short grace.
  useEffect(() => {
    const kept = [...retained.values()];
    if (holding) {
      if (kept.some((item) => item.releaseAt !== null)) {
        setRetained(new Map([...retained].map(([key, item]) => [key, { ...item, releaseAt: null }])));
      }
      return;
    }
    if (kept.some((item) => item.releaseAt === null)) {
      const now = Date.now();
      setRetained(
        new Map(
          [...retained].map(([key, item]) => [
            key,
            item.releaseAt !== null
              ? item
              : {
                  ...item,
                  releaseAt:
                    now + (seenRef.current.has(key) ? NOTICE_RELEASE_GRACE_MS : NOTICE_MIN_VISIBLE_MS),
                },
          ]),
        ),
      );
      return;
    }
    if (kept.length === 0) return;
    const nextRelease = Math.min(...kept.map((item) => item.releaseAt as number));
    const timerId = window.setTimeout(() => {
      const now = Date.now();
      setRetained((current) =>
        new Map([...current].filter(([, item]) => item.releaseAt === null || item.releaseAt > now)),
      );
    }, Math.max(0, nextRelease - Date.now()));
    return () => window.clearTimeout(timerId);
  }, [holding, retained]);

  const entries = useMemo(() => {
    const shown = live.filter((entry) => !dismissed.has(entry.key));
    for (const kept of currentRetained.values()) {
      if (!dismissed.has(kept.entry.key)) shown.push(kept.entry);
    }
    // Stable, so a kept event sorts after the live ones of its own tier.
    return orderNotices(shown.map((entry) => ({ entry, tier: entry.notice.tier }))).map(({ entry }) => entry);
  }, [live, currentRetained, dismissed]);

  useEffect(() => {
    if (suppressed) return;
    for (const entry of entries) seenRef.current.add(entry.key);
  }, [entries, suppressed]);

  // Collapsed again once there is nothing left to expand into, and nothing is
  // left under the pointer to hold.
  const isEmpty = entries.length === 0;
  const [wasEmpty, setWasEmpty] = useState(isEmpty);
  if (wasEmpty !== isEmpty) {
    setWasEmpty(isEmpty);
    if (isEmpty) {
      setExpandedState(false);
      setHeld(false);
    }
  }

  const dismiss = useCallback((entry: QueuedNotice) => {
    setDismissed((current) => new Set(current).add(entry.key));
    setRetained((current) => {
      if (!current.has(entry.key)) return current;
      const next = new Map(current);
      next.delete(entry.key);
      return next;
    });
    entry.notice.onDismiss?.();
  }, []);

  const releaseHold = useCallback(() => setHeld(false), []);
  const holdProps = useMemo<ShellNoticeHoldProps>(
    () => ({
      onPointerEnter: () => setHeld(true),
      onPointerLeave: () => setHeld(false),
      onFocus: () => setHeld(true),
      onBlur: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false);
      },
    }),
    [],
  );

  // Spoken once per occurrence, and only when it reaches the top unhindered.
  const announcedKeysRef = useRef(new Set<string>());
  const [announced, setAnnounced] = useState<QueuedNotice | null>(null);
  const top = entries[0] ?? null;
  useEffect(() => {
    if (suppressed || top === null || announcedKeysRef.current.has(top.key)) return;
    announcedKeysRef.current.add(top.key);
    setAnnounced(top);
  }, [top, suppressed]);

  return {
    entries,
    expanded: expanded && !isEmpty,
    setExpanded: setExpandedState,
    dismiss,
    holdProps,
    releaseHold,
    announced,
  };
}
