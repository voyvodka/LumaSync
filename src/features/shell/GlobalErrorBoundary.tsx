/**
 * GlobalErrorBoundary — last-resort UI catch for uncaught render errors.
 *
 * A single render exception would white-screen a tray-first app, so every window is wrapped in
 * this boundary. The error is logged through `console.error` with the `[LumaSync]` prefix, which the
 * Rust log sink mirrors to the log file, and a quiet fallback takes the window: what happened in a
 * line, Restart as the one thing to do, and beside it a prefilled issue, the log folder and a copy
 * of the error, with the raw stack behind "Details".
 *
 * Restart is a real process relaunch (tray, USB handles and Hue streams reinitialise), with a
 * WebView reload as the fallback where the plugin is missing. The fallback may import nothing
 * outside `shared/` and the two Tauri bridges: the feature module that threw might be what it would
 * pull in. Its English copy is used when i18next has not loaded yet.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { openLogDir } from "@/features/platform/platformApi";
import { APP_VERSION } from "@/shared/constants/app";
import { buildIssueReportUrl, detectOsName } from "@/shared/lib/issueReport";
import { relaunchApp } from "./launchApi";

import styles from "./GlobalErrorBoundary.module.css";

interface Props {
  children: ReactNode;
  /**
   * Translation function injected from the i18n-ready wrapper. When
   * absent (bootstrap race) the fallback card uses hardcoded English
   * copy — better than a white screen.
   */
  t?: TFunction;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  showDetails: boolean;
  copied: boolean;
}

/** How long "Copied" stays before the link reads "Copy error" again. */
const COPIED_MS = 1800;

const FALLBACK_COPY = {
  title: "Something went wrong",
  body: "The error was saved to the log.",
  restart: "Restart",
  report: "Report",
  showLogs: "Open log folder",
  copyError: "Copy error",
  copied: "Copied",
  details: "Details",
} as const;

export class GlobalErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    showDetails: false,
    copied: false,
  };

  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  componentWillUnmount() {
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    // [LumaSync] prefix routes to tauri-plugin-log via the console
    // forwarder configured in Rust, so this also lands in the on-disk
    // log file the user can attach to a bug report.
    console.error(
      "[LumaSync] Uncaught render error — GlobalErrorBoundary caught:",
      error,
      errorInfo,
    );
  }

  private handleRestart = () => {
    // A real process relaunch is preferred so the tray icon, USB handles and Hue
    // streams all reinitialise; the WebView reload is the no-plugin fallback.
    void (async () => {
      try {
        await relaunchApp();
      } catch (err) {
        console.warn(
          "[LumaSync] relaunch() failed — falling back to WebView reload:",
          err,
        );
        window.location.reload();
      }
    })();
  };

  private handleShowLogs = async () => {
    try {
      await openLogDir();
    } catch (err) {
      console.error("[LumaSync] open_log_dir failed:", err);
    }
  };

  private handleCopyError = async () => {
    const { error, errorInfo } = this.state;
    const payload = [
      `[LumaSync] Uncaught render error`,
      `Name: ${error?.name ?? "unknown"}`,
      `Message: ${error?.message ?? "unknown"}`,
      ``,
      `Stack:`,
      error?.stack ?? "(no stack)",
      ``,
      `Component stack:`,
      errorInfo?.componentStack ?? "(no component stack)",
    ].join("\n");

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
        this.setState({ copied: true });
        if (this.copiedTimer) clearTimeout(this.copiedTimer);
        this.copiedTimer = setTimeout(() => this.setState({ copied: false }), COPIED_MS);
      } else {
        // Non-fatal fallback: log the payload so the user can still
        // recover it from devtools or the Tauri log file.
        console.error("[LumaSync] Clipboard API unavailable — dumping error payload:\n", payload);
      }
    } catch (clipboardError) {
      console.error("[LumaSync] Failed to copy error payload:", clipboardError);
    }
  };

  private handleToggleDetails = () => {
    this.setState((prev) => ({ showDetails: !prev.showDetails }));
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const { t } = this.props;
    const copy = {
      title: t ? t("shell:errorBoundary.title") : FALLBACK_COPY.title,
      body: t ? t("shell:errorBoundary.body") : FALLBACK_COPY.body,
      restart: t ? t("shell:errorBoundary.restart") : FALLBACK_COPY.restart,
      report: t ? t("shell:errorBoundary.report") : FALLBACK_COPY.report,
      showLogs: t ? t("shell:errorBoundary.showLogs") : FALLBACK_COPY.showLogs,
      copyError: t ? t("shell:errorBoundary.copyError") : FALLBACK_COPY.copyError,
      copied: t ? t("shell:errorBoundary.copied") : FALLBACK_COPY.copied,
      details: t ? t("shell:errorBoundary.details") : FALLBACK_COPY.details,
    };

    const { error, errorInfo, showDetails, copied } = this.state;
    const reportUrl = buildIssueReportUrl(APP_VERSION, detectOsName(), {
      message: `${error?.name ?? "Error"}: ${error?.message ?? "unknown"}`,
      stack: error?.stack,
    });

    return (
      // `lm-errboundary-root` is how e2e and the UI audit tell the fallback is up.
      <div className={`lm-errboundary-root ${styles.root}`} role="alert" aria-live="assertive">
        <section className={styles.panel} aria-labelledby="lm-errboundary-title">
          <h1 id="lm-errboundary-title" className={styles.title}>
            {copy.title}
          </h1>
          <p className={styles.body}>{copy.body}</p>

          <button type="button" className={styles.restart} onClick={this.handleRestart}>
            {copy.restart}
          </button>

          <div className={styles.links}>
            <a className={styles.link} href={reportUrl} target="_blank" rel="noreferrer">
              {copy.report}
            </a>
            <span aria-hidden className={styles.dot}>·</span>
            <button
              type="button"
              className={styles.link}
              onClick={() => {
                void this.handleShowLogs();
              }}
            >
              {copy.showLogs}
            </button>
            <span aria-hidden className={styles.dot}>·</span>
            <button
              type="button"
              className={styles.link}
              aria-live="polite"
              onClick={() => {
                void this.handleCopyError();
              }}
            >
              {copied ? copy.copied : copy.copyError}
            </button>
          </div>

          <button
            type="button"
            className={styles.detailsToggle}
            onClick={this.handleToggleDetails}
            aria-expanded={showDetails}
            aria-controls="lm-errboundary-details"
          >
            {copy.details}
            <svg aria-hidden viewBox="0 0 12 12" className={styles.chevron}>
              <path d="M4.5 3 7.5 6 4.5 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {showDetails && (
            <pre id="lm-errboundary-details" className={styles.details} aria-label={copy.details}>
              {error?.stack ?? error?.message ?? "(no error info)"}
              {errorInfo?.componentStack ? `\n\nComponent stack:${errorInfo.componentStack}` : ""}
            </pre>
          )}
        </section>
      </div>
    );
  }
}

/**
 * i18n-aware wrapper that injects the `t` function once the i18next
 * context is ready. Consumers should use this export rather than the
 * raw class so the fallback card respects the user's language.
 */
export function GlobalErrorBoundaryWithI18n({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return <GlobalErrorBoundary t={t}>{children}</GlobalErrorBoundary>;
}
