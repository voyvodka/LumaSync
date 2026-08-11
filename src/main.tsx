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
 * Window routing (v1.6 LED Preview): BOTH preview windows load the same
 * `index.html`, so we branch on `getCurrentWindow().label` BEFORE the heavy
 * `<App />` tree (and its device / Hue / capture effects) mounts:
 *   - label starts with `led-twin-overlay-` ⇒ the click-through digital-twin
 *     overlay, threaded with the Rust-injected `__LUMASYNC_TWIN_DISPLAY_ID__`,
 *   - label === `led-control-popup` ⇒ the interactive control popup,
 *   - else ⇒ the normal main-window `<App />`.
 *
 * Error-boundary policy (FE-5): every webview gets a boundary, because a single
 * render throw white-screens a tray-first app:
 *   - the main window and the (opaque) control popup are wrapped in
 *     `GlobalErrorBoundaryWithI18n`, whose fallback is the amber Rev 07 card,
 *   - the transparent click-through twin overlay is wrapped in the minimal
 *     `TwinErrorBoundary`, whose fallback renders NOTHING — an opaque card here
 *     would blanket the whole display, so a twin failure must degrade to an
 *     invisible overlay instead.
 *
 * Twin transparency (FE-2): the twin window is created transparent+visible, but
 * index.html's bundled global body gradient paints an opaque app background
 * before React mounts. We neutralize html/body/#root background SYNCHRONOUSLY
 * here — before bootstrap / i18n / React — so the twin never flashes an opaque
 * full-screen frame on open. `LedTwinOverlay`'s own effect keeps doing the same
 * as belt-and-suspenders. The opaque control popup is intentionally untouched.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { error as logError, info as logInfo, warn as logWarn } from "@tauri-apps/plugin-log";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import "./styles.css";
import { Providers } from "./app/providers";
import { resolveInitialLanguage } from "./features/i18n/languagePolicy";
import { initI18n } from "./features/i18n/i18n";
import { GlobalErrorBoundaryWithI18n } from "./features/shell/GlobalErrorBoundary";
import { LedTwinOverlay } from "./features/preview/ui/LedTwinOverlay";
import { TwinErrorBoundary } from "./features/preview/ui/TwinErrorBoundary";
import { ControlPopupApp } from "./features/preview/ui/ControlPopupApp";
import {
  LED_CONTROL_POPUP_LABEL,
  LED_TWIN_OVERLAY_LABEL_PREFIX,
} from "./shared/contracts/preview";

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

/**
 * FE-2 fix — neutralize the opaque global app background on the twin overlay
 * window SYNCHRONOUSLY, before bootstrap / i18n / React mount.
 *
 * The twin window is `.transparent(true).visible(true)` and shown immediately,
 * but index.html's bundled body gradient (plain CSS, no `!important`) paints
 * opaque over the full display from first paint until `LedTwinOverlay`'s effect
 * runs — and that effect only fires after first paint AND after `await
 * initI18n`. The result was a visible full-screen opaque flash on every twin
 * open. Setting the inline background to `transparent` here (inline beats the
 * non-`!important` stylesheet rule) removes the flash entirely. Only the twin
 * window is touched — the control popup stays opaque.
 */
function neutralizeTwinBackgroundEarly() {
  let label = "";
  try {
    label = getCurrentWindow().label;
  } catch (err) {
    console.error(
      "[LumaSync] could not resolve window label for early twin transparency:",
      err,
    );
    return;
  }
  if (!label.startsWith(LED_TWIN_OVERLAY_LABEL_PREFIX)) return;

  document.documentElement.style.background = "transparent";
  if (document.body) document.body.style.background = "transparent";
  const root = document.getElementById("root");
  if (root) root.style.background = "transparent";
}

neutralizeTwinBackgroundEarly();

/**
 * Resolve the current webview label and pick the React tree to render.
 *
 * The display id for the twin overlay is read from the Rust-injected
 * `window.__LUMASYNC_TWIN_DISPLAY_ID__` global (mirrors the calibration
 * overlay's `__LUMASYNC_OVERLAY_PREVIEW__`). Each branch carries an error
 * boundary suited to its window — opaque card for chrome windows, invisible
 * fallback for the transparent twin (see file header).
 */
function resolveRootTree(): React.ReactNode {
  let label = "";
  try {
    label = getCurrentWindow().label;
  } catch (err) {
    console.error("[LumaSync] could not resolve window label; defaulting to main App:", err);
  }

  if (label.startsWith(LED_TWIN_OVERLAY_LABEL_PREFIX)) {
    const displayId = (window as unknown as { __LUMASYNC_TWIN_DISPLAY_ID__?: string })
      .__LUMASYNC_TWIN_DISPLAY_ID__;
    return (
      <Providers>
        <TwinErrorBoundary>
          <LedTwinOverlay displayId={displayId} scope="test" />
        </TwinErrorBoundary>
      </Providers>
    );
  }

  if (label === LED_CONTROL_POPUP_LABEL) {
    return (
      <Providers>
        <GlobalErrorBoundaryWithI18n>
          <ControlPopupApp />
        </GlobalErrorBoundaryWithI18n>
      </Providers>
    );
  }

  return (
    <Providers>
      <GlobalErrorBoundaryWithI18n>
        <App />
      </GlobalErrorBoundaryWithI18n>
    </Providers>
  );
}

function renderRoot() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>{resolveRootTree()}</React.StrictMode>,
  );
}

async function bootstrap() {
  // 1. Resolve language (honours I18N-02: English default on first launch)
  const language = await resolveInitialLanguage();

  // 2. Initialise i18next with resolved language
  await initI18n(language);

  // 3. Mount React (window-label routing happens inside resolveRootTree)
  renderRoot();
}

bootstrap().catch((err) => {
  // Bootstrap failure is non-fatal: fall back to English i18n and render anyway
  console.error("[LumaSync] Bootstrap error:", err);
  // Render even if the fallback init also fails — an uninitialised i18next
  // echoes keys, but skipping renderRoot leaves a permanently blank webview
  // with the ErrorBoundary trapped inside a tree that never mounted.
  initI18n("en")
    .catch((initErr) => {
      console.error("[LumaSync] Fallback i18n init failed:", initErr);
    })
    .finally(() => {
      renderRoot();
    });
});
