import { useTranslation, Trans } from "react-i18next";
import type { Update } from "@tauri-apps/plugin-updater";
import type { UpdaterState } from "./useAutoUpdater";

interface UpdateModalProps {
  state: UpdaterState;
  onInstall: (update: Update) => void;
  onDismiss: () => void;
  onRetry: () => void;
}

// Download arrow (used for available + downloading)
function IconDownload() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v13M6 10l6 6 6-6M4 21h16" />
    </svg>
  );
}

// Plus/cross install icon
function IconInstall() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v20M2 12h20" />
    </svg>
  );
}

// Error alert icon
function IconError() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  const digits = value >= 100 || i === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[i]}`;
}

function formatSpeed(bps: number): string {
  if (bps <= 0) return "—";
  return `${formatBytes(bps)}/s`;
}

function formatEta(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

type Note = { kind: "add" | "fix" | "change" | null; text: string };

// Minimal markdown renderer for release notes body.
// Scans all meaningful lines, tags Added/Fixed/Changed sections, drops headers.
// Notes block is scrollable so no hard limit needed.
function parseReleaseNotes(body: string | undefined): Note[] {
  if (!body) return [];
  const rawLines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const notes: Note[] = [];
  let currentKind: Note["kind"] = null;

  for (const line of rawLines) {
    const sectionMatch = /^#+\s*(added|fixed|changed|removed|new|fix)/i.exec(line);
    if (sectionMatch) {
      const head = sectionMatch[1].toLowerCase();
      if (head === "added" || head === "new") currentKind = "add";
      else if (head === "fixed" || head === "fix") currentKind = "fix";
      else currentKind = "change";
      continue;
    }

    const bulletMatch = /^[-*•]\s+(.*)$/.exec(line);
    if (bulletMatch) {
      notes.push({ kind: currentKind, text: bulletMatch[1] });
      continue;
    }

    if (!line.startsWith("#")) {
      notes.push({ kind: currentKind, text: line });
    }
  }

  return notes;
}

export function UpdateModal({ state, onInstall, onDismiss, onRetry }: UpdateModalProps) {
  const { t } = useTranslation("common");

  if (
    state.status !== "available" &&
    state.status !== "downloading" &&
    state.status !== "installing" &&
    state.status !== "error"
  ) {
    return null;
  }

  return (
    <div
      className="lm-updater-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lm-updater-title"
    >
      <div className="lm-updater-modal">
        {/* ── Available ─────────────────────────────────────────────── */}
        {state.status === "available" && (
          <AvailableContent
            update={state.update}
            onDismiss={onDismiss}
            onInstall={() => onInstall(state.update)}
            t={t}
          />
        )}

        {/* ── Downloading ───────────────────────────────────────────── */}
        {state.status === "downloading" && (
          <DownloadingContent
            version={state.update.version}
            progress={state.progress}
            downloadedBytes={state.downloadedBytes}
            totalBytes={state.totalBytes}
            bytesPerSecond={state.bytesPerSecond}
            etaSeconds={state.etaSeconds}
            onBackground={onDismiss}
            t={t}
          />
        )}

        {/* ── Installing ────────────────────────────────────────────── */}
        {state.status === "installing" && (
          <InstallingContent version={state.update.version} onDismiss={onDismiss} t={t} />
        )}

        {/* ── Error ─────────────────────────────────────────────────── */}
        {state.status === "error" && (
          <ErrorContent message={state.message} onDismiss={onDismiss} onRetry={onRetry} t={t} />
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// State components
// ────────────────────────────────────────────────────────────────────

type TFn = ReturnType<typeof useTranslation>["t"];

function AvailableContent({
  update,
  onDismiss,
  onInstall,
  t,
}: {
  update: Update;
  onDismiss: () => void;
  onInstall: () => void;
  t: TFn;
}) {
  const notes = parseReleaseNotes(update.body);
  const currentVersion = update.currentVersion;
  const nextVersion = update.version;
  const sizeLabel = t("updater.sizeUnknown");

  return (
    <>
      <div className="lm-updater-head">
        <div className="lm-updater-badge">
          <IconDownload />
        </div>
        <div className="lm-updater-titlewrap">
          <div className="lm-updater-eyebrow">{t("updater.available.eyebrow")}</div>
          <div className="lm-updater-title" id="lm-updater-title">
            {t("updater.available.title")}
          </div>
        </div>
      </div>

      <div className="lm-updater-body">
        <Trans t={t} i18nKey="updater.available.body" values={{ version: nextVersion }} components={{ b: <b /> }} />
      </div>

      <div className="lm-updater-verdiff">
        <span className="lm-updater-verdiff-from">v{currentVersion}</span>
        <span className="lm-updater-verdiff-arrow">→</span>
        <span className="lm-updater-verdiff-to">v{nextVersion}</span>
        <span className="lm-updater-verdiff-size">· {sizeLabel}</span>
      </div>

      {notes.length > 0 && (
        <div className="lm-updater-notes">
          {notes.map((note, idx) => (
            <span key={idx} className="lm-updater-notes-line">
              {note.kind && (
                <span className={`lm-updater-tag is-${note.kind === "fix" ? "fix" : "add"}`}>
                  {note.kind === "fix" ? t("updater.noteKind.fix") : note.kind === "add" ? t("updater.noteKind.add") : t("updater.noteKind.change")}
                </span>
              )}
              {note.text}
            </span>
          ))}
        </div>
      )}

      <div className="lm-updater-actions">
        <button type="button" className="lm-updater-btn-ghost" onClick={onDismiss}>
          {t("updater.actions.later")}
        </button>
        <button type="button" className="lm-updater-btn-primary" onClick={onInstall}>
          {t("updater.actions.install")}
        </button>
      </div>
    </>
  );
}

function DownloadingContent({
  version,
  progress,
  downloadedBytes,
  totalBytes,
  bytesPerSecond,
  etaSeconds,
  onBackground,
  t,
}: {
  version: string;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  onBackground: () => void;
  t: TFn;
}) {
  const clamped = Math.max(0, Math.min(100, progress));
  return (
    <>
      <div className="lm-updater-head">
        <div className="lm-updater-badge">
          <IconDownload />
        </div>
        <div className="lm-updater-titlewrap">
          <div className="lm-updater-eyebrow">{t("updater.downloading.eyebrow")}</div>
          <div className="lm-updater-title" id="lm-updater-title">
            {t("updater.downloading.title", { version })}
          </div>
        </div>
      </div>

      <div className="lm-updater-body">{t("updater.downloading.body")}</div>

      <div className="lm-updater-prog">
        <div className="lm-updater-prog-row">
          <span>{t("updater.downloading.progressLabel")}</span>
          <b>
            <em>{clamped}</em>%
          </b>
        </div>
        <div className="lm-updater-prog-track" role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
          <span className="lm-updater-prog-fill" style={{ width: `${clamped}%` }} />
        </div>
        <div className="lm-updater-prog-stats">
          <span>
            <b>{formatBytes(downloadedBytes)}</b>
            {totalBytes > 0 ? ` / ${formatBytes(totalBytes)}` : ""}
          </span>
          <span>{formatSpeed(bytesPerSecond)}</span>
          <span>
            {t("updater.downloading.etaLabel")} <b>{formatEta(etaSeconds)}</b>
          </span>
        </div>
      </div>

      <div className="lm-updater-actions">
        <button type="button" className="lm-updater-btn-ghost" onClick={onBackground}>
          {t("updater.actions.background")}
        </button>
      </div>
    </>
  );
}

function InstallingContent({ version, onDismiss, t }: { version: string; onDismiss: () => void; t: TFn }) {
  return (
    <>
      <div className="lm-updater-head">
        <div className="lm-updater-badge">
          <IconInstall />
        </div>
        <div className="lm-updater-titlewrap">
          <div className="lm-updater-eyebrow">{t("updater.installing.eyebrow")}</div>
          <div className="lm-updater-title" id="lm-updater-title">
            {t("updater.installing.title")}
          </div>
        </div>
      </div>

      <div className="lm-updater-spinner" aria-hidden="true" />

      <div className="lm-updater-install-txt">
        <b>{t("updater.installing.verify")}</b>
        <span>
          <Trans t={t} i18nKey="updater.installing.body" values={{ version }} components={{ br: <br /> }} />
        </span>
      </div>

      {import.meta.env.DEV && (
        <div className="lm-updater-actions">
          <button type="button" className="lm-updater-btn-ghost" onClick={onDismiss}>
            [dev] Close
          </button>
        </div>
      )}
    </>
  );
}

function ErrorContent({
  message,
  onDismiss,
  onRetry,
  t,
}: {
  message: string;
  onDismiss: () => void;
  onRetry: () => void;
  t: TFn;
}) {
  return (
    <>
      <div className="lm-updater-head">
        <div className="lm-updater-badge is-error">
          <IconError />
        </div>
        <div className="lm-updater-titlewrap">
          <div className="lm-updater-eyebrow is-error">{t("updater.error.eyebrow")}</div>
          <div className="lm-updater-title" id="lm-updater-title">
            {t("updater.error.title")}
          </div>
        </div>
      </div>

      <div className="lm-updater-body">{t("updater.error.body")}</div>

      <div className="lm-updater-errbox">
        <b>{t("updater.error.boxTitle")}</b>
        {message}
      </div>

      <div className="lm-updater-actions">
        <div className="lm-updater-actions-spacer" />
        <button type="button" className="lm-updater-btn-ghost" onClick={onDismiss}>
          {t("updater.actions.close")}
        </button>
        <button type="button" className="lm-updater-btn-retry" onClick={onRetry}>
          {t("updater.actions.retry")}
        </button>
      </div>
    </>
  );
}
