// main.tsx — entry point. Bootstrap: resolve language → init i18next → mount
// React. Every window loads this same index.html, branches on
// `getCurrentWindow().label`, and imports only its own root tree — the twin
// overlay and the popup never parse `<App />`. See
// docs/architecture/ui-and-shell.md, "Per-window bundles".

import React, { type ComponentType } from "react";
import ReactDOM from "react-dom/client";
import { error as logError, info as logInfo, warn as logWarn } from "@tauri-apps/plugin-log";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";
import { Providers } from "./app/providers";
import { followSavedLanguage, resolveInitialLanguage } from "./features/i18n/languagePolicy";
import { initI18n } from "./features/i18n/i18n";
import { GlobalErrorBoundaryWithI18n } from "./features/shell/GlobalErrorBoundary";
import { TwinErrorBoundary } from "./features/preview/ui/TwinErrorBoundary";
import {
  LED_CONTROL_POPUP_LABEL,
  LED_TWIN_OVERLAY_LABEL_PREFIX,
} from "./shared/contracts/preview";

// Mirrors console output into the Rust log sink — see
// docs/architecture/ui-and-shell.md. We wrap the originals (not replace
// them) so DevTools still shows correct source locations.
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

  // A dead bridge used to be invisible. Report once through the unwrapped
  // console.error so a rejected log invoke cannot recurse.
  let bridgeFailed = false;
  const onBridgeFailure = (err: unknown) => {
    if (bridgeFailed) return;
    bridgeFailed = true;
    originalError("[LumaSync] console→log bridge failed; Rust log sink is missing frontend lines:", err);
  };

  console.info = (...args: unknown[]) => {
    originalInfo(...args);
    void logInfo(fmt(args)).catch(onBridgeFailure);
  };
  console.log = (...args: unknown[]) => {
    originalLog(...args);
    void logInfo(fmt(args)).catch(onBridgeFailure);
  };
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    void logWarn(fmt(args)).catch(onBridgeFailure);
  };
  console.error = (...args: unknown[]) => {
    originalError(...args);
    void logError(fmt(args)).catch(onBridgeFailure);
  };
}

bridgeConsoleToTauri();

// FE-2 — clear the twin window's background synchronously, before bootstrap
// runs, so it never flashes the opaque app gradient. See
// docs/architecture/ui-and-shell.md. Only the twin is touched.
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
  // A dark `color-scheme` can hand an unpainted root a dark canvas instead of
  // leaving it clear; the twin has no native controls to theme.
  document.documentElement.style.colorScheme = "normal";
  if (document.body) document.body.style.background = "transparent";
  const root = document.getElementById("root");
  if (root) root.style.background = "transparent";
}

neutralizeTwinBackgroundEarly();

const WINDOW_KIND = {
  MAIN: "main",
  POPUP: "popup",
  TWIN: "twin",
} as const;
type WindowKind = (typeof WINDOW_KIND)[keyof typeof WINDOW_KIND];

function resolveWindowKind(): WindowKind {
  let label = "";
  try {
    label = getCurrentWindow().label;
  } catch (err) {
    console.error("[LumaSync] could not resolve window label; defaulting to main App:", err);
  }
  if (label.startsWith(LED_TWIN_OVERLAY_LABEL_PREFIX)) return WINDOW_KIND.TWIN;
  if (label === LED_CONTROL_POPUP_LABEL) return WINDOW_KIND.POPUP;
  return WINDOW_KIND.MAIN;
}

/**
 * Import only this window's root tree.
 *
 * The display id for the twin overlay is read from the Rust-injected
 * `window.__LUMASYNC_TWIN_DISPLAY_ID__` global (mirrors the calibration
 * overlay's `__LUMASYNC_OVERLAY_PREVIEW__`).
 */
async function loadWindowRoot(kind: WindowKind): Promise<ComponentType> {
  switch (kind) {
    case WINDOW_KIND.TWIN: {
      const { LedTwinOverlay } = await import("./features/preview/ui/LedTwinOverlay");
      return function TwinRoot() {
        const displayId = (window as unknown as { __LUMASYNC_TWIN_DISPLAY_ID__?: string })
          .__LUMASYNC_TWIN_DISPLAY_ID__;
        return <LedTwinOverlay displayId={displayId} scope="test" />;
      };
    }
    case WINDOW_KIND.POPUP: {
      const { ControlPopupApp } = await import("./features/preview/ui/ControlPopupApp");
      return function PopupRoot() {
        return <ControlPopupApp />;
      };
    }
    case WINDOW_KIND.MAIN: {
      const { default: App } = await import("./App");
      return function MainRoot() {
        return <App />;
      };
    }
  }
}

/** Rethrows a failed root import during render, so the window's own boundary handles it. */
function failedRoot(error: unknown): ComponentType {
  return function FailedRoot(): never {
    throw error;
  };
}

const windowKind = resolveWindowKind();
// Started before the language read, so the chunk and the shell-state IPC run
// in parallel. Never rejects: see `failedRoot`.
const windowRoot = loadWindowRoot(windowKind).catch((err: unknown) => {
  console.error(`[LumaSync] could not load the ${windowKind} window's root module:`, err);
  return failedRoot(err);
});

/**
 * Each window carries an error boundary suited to it — opaque card for chrome
 * windows, invisible fallback for the transparent twin (see file header).
 */
function renderRoot(Root: ComponentType) {
  const tree =
    windowKind === WINDOW_KIND.TWIN ? (
      // TwinErrorBoundary renders nothing on failure — an opaque fallback
      // here would blanket the display. See docs/architecture/ui-and-shell.md.
      <TwinErrorBoundary>
        <Root />
      </TwinErrorBoundary>
    ) : (
      <GlobalErrorBoundaryWithI18n>
        <Root />
      </GlobalErrorBoundaryWithI18n>
    );
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Providers>{tree}</Providers>
    </React.StrictMode>,
  );
}

async function bootstrap() {
  // 1. Resolve language (honours I18N-02: English default on first launch)
  const language = await resolveInitialLanguage();

  // 2. Initialise i18next with resolved language
  await initI18n(language);
  // The popup is hidden and reused, never rebuilt, so it would keep the
  // language it was created in; the main window switches itself.
  if (windowKind === WINDOW_KIND.POPUP) followSavedLanguage();

  // 3. Mount React once this window's root module is in
  renderRoot(await windowRoot);
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
      void windowRoot.then(renderRoot);
    });
});
