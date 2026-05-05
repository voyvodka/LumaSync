/**
 * main.tsx — Application entry point
 *
 * Bootstrap order:
 *  1. Resolve initial language via languagePolicy (I18N-02: English on first launch)
 *  2. Initialise i18next with the resolved language
 *  3. Mount React with provider composition (I18nextProvider, etc.)
 *
 * i18next is initialised BEFORE React renders to prevent hydration flicker
 * and ensure all components receive a ready translation instance.
 *
 * The whole shell is wrapped in `GlobalErrorBoundaryWithI18n` so an
 * uncaught render error surfaces the amber Rev 07 fallback card instead
 * of a white screen. The boundary lives INSIDE `<Providers>` so its
 * `useTranslation` hook resolves against the live i18next context; a
 * hardcoded English fallback still covers the i18n-not-ready race.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { error as logError, info as logInfo, warn as logWarn } from "@tauri-apps/plugin-log";
import App from "./App";
import "./styles.css";
import { Providers } from "./app/providers";
import { resolveInitialLanguage } from "./features/i18n/languagePolicy";
import { initI18n } from "./features/i18n/i18n";
import { GlobalErrorBoundaryWithI18n } from "./features/shell/GlobalErrorBoundary";

// Bridge browser `console.log/info/warn/error` to the Rust tauri-plugin-log
// file sink so frontend output is captured in the same log file Rust writes
// to (`~/Library/Logs/com.lumasync.app/lumasync-dev.log` on macOS). Without
// this, frontend `console.*` calls live in the WebView devtools panel only,
// which makes runtime debugging from outside DevTools impossible. The
// browser console panel still receives the same entries — we wrap the
// originals rather than replacing them so source-location attribution is
// preserved in DevTools.
//
// `attachConsole` from @tauri-apps/plugin-log routes Rust logs TO the
// browser console (the opposite direction we want); the explicit
// `info`/`warn`/`error` exports invoke the plugin command which lands in
// the plugin's target chain (Stdout + LogDir).
function bridgeConsoleToTauri() {
  const fmt = (args: unknown[]) =>
    args
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");

  const originalInfo = console.info.bind(console);
  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.info = (...args: unknown[]) => {
    originalInfo(...args);
    void logInfo(fmt(args)).catch(() => {});
  };
  console.log = (...args: unknown[]) => {
    originalLog(...args);
    void logInfo(fmt(args)).catch(() => {});
  };
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    void logWarn(fmt(args)).catch(() => {});
  };
  console.error = (...args: unknown[]) => {
    originalError(...args);
    void logError(fmt(args)).catch(() => {});
  };
}

bridgeConsoleToTauri();

async function bootstrap() {
  // 1. Resolve language (honours I18N-02: English default on first launch)
  const language = await resolveInitialLanguage();

  // 2. Initialise i18next with resolved language
  await initI18n(language);

  // 3. Mount React
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Providers>
        <GlobalErrorBoundaryWithI18n>
          <App />
        </GlobalErrorBoundaryWithI18n>
      </Providers>
    </React.StrictMode>,
  );
}

bootstrap().catch((err) => {
  // Bootstrap failure is non-fatal: fall back to English i18n and render anyway
  console.error("[LumaSync] Bootstrap error:", err);
  initI18n("en").then(() => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <Providers>
          <GlobalErrorBoundaryWithI18n>
            <App />
          </GlobalErrorBoundaryWithI18n>
        </Providers>
      </React.StrictMode>,
    );
  });
});
