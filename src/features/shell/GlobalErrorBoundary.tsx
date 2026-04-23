/**
 * GlobalErrorBoundary — last-resort UI catch for uncaught render errors.
 *
 * A single render exception will white-screen a tray-first app, so the
 * entire shell must be wrapped in this boundary. When React bubbles an
 * error up here we log it to both `console.error` and (transitively)
 * `tauri-plugin-log` via the `[LumaSync]` prefix that the Rust log sink
 * already mirrors, then render a compact amber-palette fallback card
 * with actionable recovery buttons.
 *
 * Recovery actions:
 *  - "Restart" → `window.location.reload()`. Full WebView reload remounts
 *    React cleanly; the Tauri process itself stays alive so tray state,
 *    USB handles and Hue streams are preserved. A future
 *    `tauri-plugin-process` integration could upgrade this to a true
 *    app relaunch (see tauri-expert handoff note in the PR body).
 *  - "Copy error" → `navigator.clipboard.writeText()` with the error
 *    name + message + stack + component stack, so the user can paste
 *    into a GitHub issue or Discord report.
 *  - "Show details" toggle → expands a `<details>` block with the raw
 *    stack trace for debugging without overwhelming first-render.
 *
 * "Show logs" is intentionally omitted until the backend exposes an
 * `open_log_dir` Tauri command (tauri-expert W3-O handoff). Falsely
 * advertising a broken button would violate the project's
 * no-false-affordance rule (UI Gap 9 / StatusBar regression).
 *
 * i18n fallback: if i18next has not finished loading when the error
 * fires (rare, but possible during bootstrap), we inject hardcoded
 * English copy so the card still renders. The `t` prop is populated by
 * the functional wrapper `GlobalErrorBoundaryWithI18n` once the i18n
 * context is ready.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import "./GlobalErrorBoundary.css";

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
}

const FALLBACK_COPY = {
  title: "Something went wrong",
  body: "We've logged the error. Restart the app or copy the details for support.",
  restart: "Restart",
  copyError: "Copy error",
  copied: "Copied",
  showDetails: "Show details",
  hideDetails: "Hide details",
} as const;

export class GlobalErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    showDetails: false,
  };

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
    // WebView reload is enough to remount React and clear the error
    // state. A proper `relaunch()` requires tauri-plugin-process which
    // is not wired in v1.4 — see tauri-expert W3-O handoff.
    window.location.reload();
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
      title: t ? t("shell.errorBoundary.title") : FALLBACK_COPY.title,
      body: t ? t("shell.errorBoundary.body") : FALLBACK_COPY.body,
      restart: t ? t("shell.errorBoundary.restart") : FALLBACK_COPY.restart,
      copyError: t ? t("shell.errorBoundary.copyError") : FALLBACK_COPY.copyError,
      showDetails: t ? t("shell.errorBoundary.showDetails") : FALLBACK_COPY.showDetails,
      hideDetails: t ? t("shell.errorBoundary.hideDetails") : FALLBACK_COPY.hideDetails,
    };

    const { error, errorInfo, showDetails } = this.state;

    return (
      <div className="lm-errboundary-root" role="alert" aria-live="assertive">
        <section
          className="lm-errboundary-card lm-settings-group"
          aria-labelledby="lm-errboundary-title"
        >
          <div className="lm-errboundary-body">
            <h2 id="lm-errboundary-title" className="lm-errboundary-title">
              {copy.title}
            </h2>
            <p className="lm-errboundary-copy">{copy.body}</p>

            <div className="lm-errboundary-actions">
              <button
                type="button"
                className="lm-errboundary-btn lm-errboundary-btn-primary"
                onClick={this.handleRestart}
              >
                {copy.restart}
              </button>
              <button
                type="button"
                className="lm-errboundary-btn"
                onClick={() => {
                  void this.handleCopyError();
                }}
              >
                {copy.copyError}
              </button>
              <button
                type="button"
                className="lm-errboundary-btn lm-errboundary-btn-ghost"
                onClick={this.handleToggleDetails}
                aria-expanded={showDetails}
                aria-controls="lm-errboundary-details"
              >
                {showDetails ? copy.hideDetails : copy.showDetails}
              </button>
            </div>

            {showDetails && (
              <pre
                id="lm-errboundary-details"
                className="lm-errboundary-details"
                aria-label={copy.showDetails}
              >
                {error?.stack ?? error?.message ?? "(no error info)"}
                {errorInfo?.componentStack ? `\n\nComponent stack:${errorInfo.componentStack}` : ""}
              </pre>
            )}
          </div>
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
  const { t } = useTranslation("common");
  return <GlobalErrorBoundary t={t}>{children}</GlobalErrorBoundary>;
}
