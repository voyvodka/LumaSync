import type { TFunction } from "i18next";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { UpdateMetadata } from "@/shared/contracts/updater";
import { clamp } from "@/shared/lib/math";
import { StateSwap } from "@/shared/ui/StateSwap/StateSwap";
import { useDialogFocus } from "@/shared/ui/useDialogFocus";
import type { UpdaterErrorPhase, UpdaterState } from "./useAutoUpdater";
import { isUpdateModalStatus } from "./updateModalStatus";
import styles from "./UpdateModal.module.css";

interface UpdateModalProps {
  state: UpdaterState;
  onInstall: (update: UpdateMetadata) => void;
  onDismiss: () => void;
  onRetry: () => void;
  /** Closing: it plays its exit and takes no more input. */
  leaving?: boolean;
  /** Dev builds only: ends a previewed download or install, which a user cannot close. */
  onDevClose?: () => void;
}

const TITLE_ID = "lm-updater-title";
/** Past the outgoing body's fade, when a state replaces another in the card. */
const SWAP_MS = 260;

function formatBytes(bytes: number, lang: string): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  const digits = value >= 100 || i === 0 ? 0 : 1;
  return `${new Intl.NumberFormat(lang, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)} ${units[i]}`;
}

function formatEta(t: TFunction, seconds: number): string {
  if (seconds < 60) return t("updater:eta.seconds", { seconds });
  return t("updater:eta.minutes", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

type NoteKind = "add" | "change" | "fix";
interface NoteGroup {
  kind: NoteKind | null;
  items: string[];
}

const NOTE_HEADING: Record<NoteKind, "updater:noteKind.add" | "updater:noteKind.change" | "updater:noteKind.fix"> = {
  add: "updater:noteKind.add",
  change: "updater:noteKind.change",
  fix: "updater:noteKind.fix",
};

/** The release body's bullets, grouped under the changelog's own headings, in its order. */
function parseReleaseNotes(body: string | undefined): NoteGroup[] {
  if (!body) return [];
  const groups: NoteGroup[] = [];
  let current: NoteGroup | null = null;
  for (const line of body.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const section = /^#+\s*(added|new|fixed|fix|changed|removed)/i.exec(line)?.[1]?.toLowerCase();
    if (section) {
      const kind: NoteKind = section === "added" || section === "new" ? "add" : section.startsWith("fix") ? "fix" : "change";
      current = groups.find((g) => g.kind === kind) ?? null;
      if (!current) {
        current = { kind, items: [] };
        groups.push(current);
      }
      continue;
    }
    if (line.startsWith("#")) continue;
    const text = /^[-*•]\s+(.*)$/.exec(line)?.[1] ?? line;
    if (!current) {
      current = { kind: null, items: [] };
      groups.push(current);
    }
    current.items.push(text);
  }
  return groups.filter((g) => g.items.length > 0);
}

/**
 * The update prompt: one card for every state, which grows or shrinks to the next state's content
 * while the old one fades out under the new. No blur behind it and nothing that loops — progress
 * is a bar that fills, and an install that cannot report progress shows it full and says what
 * happens next.
 */
export function UpdateModal({ state, onInstall, onDismiss, onRetry, leaving = false, onDevClose }: UpdateModalProps) {
  const { t, i18n } = useTranslation();
  // Escape is offered only where the content offers a dismiss. A download runs
  // straight into the install and relaunch (one backend call), so once it has
  // started there is nothing to back out of.
  const busy = state.status === "downloading" || state.status === "installing";
  const { containerRef, handleKeyDown } = useDialogFocus(state.status !== "idle" && !leaving, {
    onClose: busy ? undefined : onDismiss,
  });

  if (!isUpdateModalStatus(state)) return null;
  const lang = i18n?.language ?? "en";

  const devClose =
    import.meta.env.DEV && onDevClose ? (
      <button type="button" className={styles.ghost} onClick={onDevClose}>
        [dev] Close
      </button>
    ) : null;

  let body: ReactNode;
  switch (state.status) {
    case "available":
      body = (
        <Available update={state.update} onDismiss={onDismiss} onInstall={() => onInstall(state.update)} lang={lang} t={t} />
      );
      break;
    case "downloading": {
      const total = state.totalBytes > 0 ? formatBytes(state.totalBytes, lang) : null;
      const done = formatBytes(state.downloadedBytes, lang);
      const amount = total ? t("updater:downloading.amount", { done, total }) : done;
      const line = state.etaSeconds !== null ? `${amount} · ${t("updater:downloading.left", { time: formatEta(t, state.etaSeconds) })}` : amount;
      body = (
        <Progress
          title={t("updater:downloading.title", { version: state.update.version })}
          value={clamp(state.progress, 0, 100)}
          showValue
          line={line}
          label={t("updater:downloading.progressLabel")}
          actions={devClose}
        />
      );
      break;
    }
    case "installing":
      body = (
        <Progress
          title={t("updater:installing.title", { version: state.update.version })}
          value={100}
          line={t("updater:installing.body")}
          label={t("updater:installing.title", { version: state.update.version })}
          actions={devClose}
        />
      );
      break;
    case "error":
      body = (
        <Failure
          phase={state.phase}
          message={state.message}
          retrying={state.retrying === true}
          onDismiss={onDismiss}
          onRetry={onRetry}
          t={t}
        />
      );
      break;
  }

  return (
    <div
      ref={containerRef}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      className={styles.scrim}
      data-leaving={leaving || undefined}
      inert={leaving}
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
    >
      <Card swapKey={state.status}>{body}</Card>
    </div>
  );
}

/**
 * The card's height follows its content, and a new state's body arrives over the old one's
 * fade-out rather than replacing it in one frame. The first size lands without travel.
 */
function Card({ swapKey, children }: { swapKey: string; children: ReactNode }) {
  const [height, setHeight] = useState<number | null>(null);
  const [sized, setSized] = useState(false);
  // The last body each state drew, so the one leaving fades out as it was (a full bar, not 0 %).
  const lastRef = useRef<{ key: string; node: ReactNode }>({ key: swapKey, node: children });
  const [currentKey, setCurrentKey] = useState(swapKey);
  const [outgoing, setOutgoing] = useState<{ key: string; node: ReactNode } | null>(null);
  if (currentKey !== swapKey) {
    setCurrentKey(swapKey);
    setOutgoing(lastRef.current);
  }
  useEffect(() => {
    lastRef.current = { key: swapKey, node: children };
  });

  useEffect(() => {
    if (!outgoing) return undefined;
    const timer = setTimeout(() => setOutgoing(null), SWAP_MS);
    return () => clearTimeout(timer);
  }, [outgoing]);

  // A callback ref, so each state's body (its own element) is measured from the frame it mounts.
  const observeInner = useCallback((inner: HTMLDivElement | null) => {
    if (!inner) return undefined;
    const measure = () => setHeight(inner.offsetHeight);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(inner);
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    if (height === null || sized) return undefined;
    const frame = requestAnimationFrame(() => setSized(true));
    return () => cancelAnimationFrame(frame);
  }, [height, sized]);

  return (
    <div
      className={styles.card}
      data-sized={sized || undefined}
      data-swapping={outgoing ? true : undefined}
      style={height === null ? undefined : { height }}
    >
      <div key={currentKey} ref={observeInner} className={outgoing ? `${styles.inner} ${styles.incoming}` : styles.inner}>
        {children}
      </div>
      {/* After the live body, so its copy of the title id is never the one the dialog is named by. */}
      {outgoing && (
        <div key={`out:${outgoing.key}`} className={styles.outgoing} aria-hidden="true" inert>
          {outgoing.node}
        </div>
      )}
    </div>
  );
}

/** The feed's RFC 3339 date as "13 April"; nothing for a missing or unreadable one. */
function releaseDate(raw: string | null | undefined, lang: string): string | null {
  if (!raw) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat(lang, { day: "numeric", month: "long" }).format(at);
}

function Available({
  update,
  onDismiss,
  onInstall,
  lang,
  t,
}: {
  update: UpdateMetadata;
  onDismiss: () => void;
  onInstall: () => void;
  lang: string;
  t: TFunction;
}) {
  // Rust sends `Option<String>` unskipped, so an absent body arrives as null.
  const groups = parseReleaseNotes(update.body ?? undefined);
  const date = releaseDate(update.date, lang);
  // Notes that run past the box fade at its foot until the end is reached, so it is plain there
  // is more — a heading sitting on the edge with its items cut off read as the whole list.
  const notesRef = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);
  const checkMore = useCallback(() => {
    const box = notesRef.current;
    if (box) setMore(box.scrollTop + box.clientHeight < box.scrollHeight - 2);
  }, []);
  useEffect(() => {
    const box = notesRef.current;
    if (!box) return undefined;
    checkMore();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(checkMore);
    observer?.observe(box);
    return () => observer?.disconnect();
  }, [checkMore]);
  return (
    <>
      <div className={styles.head}>
        <h2 id={TITLE_ID} className={styles.title}>
          {t("updater:available.title", { version: update.version })}
        </h2>
        <p className={styles.sub}>
          {update.currentVersion} → {update.version}
          {date && ` · ${date}`}
        </p>
      </div>
      {groups.length > 0 && (
        <div ref={notesRef} className={styles.notes} data-more={more || undefined} onScroll={checkMore}>
          {groups.map((group) => (
            <section key={group.kind ?? "other"} className={styles.group}>
              {group.kind && <h3 className={styles.groupTitle}>{t(NOTE_HEADING[group.kind])}</h3>}
              <ul>
                {group.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <div className={styles.actions}>
        <button type="button" className={styles.ghost} onClick={onDismiss}>
          {t("updater:actions.later")}
        </button>
        <button type="button" className={styles.primary} onClick={onInstall}>
          {t("updater:actions.install")}
        </button>
      </div>
    </>
  );
}

function Progress({
  title,
  value,
  showValue = false,
  line,
  label,
  actions,
}: {
  title: string;
  value: number;
  /** A download knows how far along it is; an install does not. */
  showValue?: boolean;
  line: string;
  label: string;
  actions: ReactNode;
}) {
  return (
    <>
      <h2 id={TITLE_ID} className={styles.title}>
        {title}
      </h2>
      <div className={styles.track} role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
        <span className={styles.fill} style={{ width: `${value}%` }} />
      </div>
      <p className={styles.line}>
        <span>{line}</span>
        {showValue && <span className={styles.value}>{value}%</span>}
      </p>
      {actions && <div className={styles.actions}>{actions}</div>}
    </>
  );
}

function Failure({
  phase,
  message,
  retrying,
  onDismiss,
  onRetry,
  t,
}: {
  phase: UpdaterErrorPhase;
  message: string;
  retrying: boolean;
  onDismiss: () => void;
  onRetry: () => void;
  t: TFunction;
}) {
  // A check that never reached the feed is not a failed installation, whatever
  // its code — an invoke-level rejection carries none. Its raw message is the
  // plugin's, which embeds the endpoint URL, so it stays a detail behind a disclosure.
  const isCheckFailure = phase === "check";
  return (
    <>
      <h2 id={TITLE_ID} className={styles.title}>
        <span className={styles.dot} aria-hidden="true" />
        {t(isCheckFailure ? "updater:error.checkTitle" : "updater:error.title")}
      </h2>
      <p className={styles.line}>{t(isCheckFailure ? "updater:error.checkBody" : "updater:error.body")}</p>
      <Disclosure label={t("updater:error.details")}>{message}</Disclosure>
      <div className={styles.actions}>
        <button type="button" className={styles.ghost} onClick={onDismiss} disabled={retrying}>
          {t("updater:actions.close")}
        </button>
        <button type="button" className={styles.primary} onClick={onRetry} disabled={retrying} aria-busy={retrying || undefined}>
          <StateSwap state={retrying ? "busy" : "idle"} faces={{ idle: t("updater:actions.retry"), busy: t("updater:checking") }} fit />
        </button>
      </div>
    </>
  );
}

/**
 * The raw detail behind a failure, opened on request. It grows open and folds shut the same way,
 * and stays mounted so the fold has something to animate.
 */
function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={styles.details} data-open={open || undefined}>
      <button type="button" className={styles.summary} aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <svg viewBox="0 0 12 12" aria-hidden="true" className={styles.chevron}>
          <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {label}
      </button>
      <div id={id} className={styles.fold} inert={!open}>
        <div className={styles.foldInner}>
          <p>{children}</p>
        </div>
      </div>
    </div>
  );
}
