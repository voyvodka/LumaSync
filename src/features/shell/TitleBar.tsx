/**
 * TitleBar — custom cross-platform window title bar.
 *
 * Layout per platform:
 *   macOS:       [80px traffic-light spacer] [app name] ——— [compact toggle]
 *   Windows/Linux: [icon] [app name]          ——— [compact toggle] [— □ ✕]
 *
 * The whole bar is a `data-tauri-drag-region`, which gives us native window
 * drag AND native double-click zoom/maximize on all platforms without any
 * JS handlers. Interactive elements opt out via
 * `data-tauri-drag-region="false"` so clicks pass through to React.
 *
 * macOS keeps native traffic lights (via `titleBarStyle: "Overlay"` +
 * `hiddenTitle: true` in tauri.conf.json). Windows/Linux disable native
 * decorations at runtime (see `src-tauri/src/lib.rs` setup hook) and this
 * component draws custom minimize / maximize-toggle / close buttons.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Platform = "macos" | "windows" | "linux";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPod|iPad/i.test(ua)) return "macos";
  if (/Win/i.test(ua)) return "windows";
  return "linux";
}

interface TitleBarProps {
  uiMode: "full" | "compact";
  onSwitchUIMode: (mode: "full" | "compact") => void;
}

export const TITLE_BAR_HEIGHT_PX = 36;

export function TitleBar({ uiMode, onSwitchUIMode }: TitleBarProps) {
  const { t } = useTranslation("common");
  const [platform] = useState<Platform>(detectPlatform);
  const [isMaximized, setIsMaximized] = useState(false);

  // Track native maximize state so the toggle icon stays in sync with the
  // actual window (double-click, Win+Up, etc. all bypass our button).
  useEffect(() => {
    if (platform === "macos") return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then(setIsMaximized);
    void win
      .onResized(() => {
        void win.isMaximized().then(setIsMaximized);
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, [platform]);

  const toggleVariant = uiMode === "compact" ? "to-full" : "to-compact";
  const toggleTitle = t(
    toggleVariant === "to-full" ? "settings.switchToFull" : "settings.switchToCompact",
  );
  const handleToggle = () => onSwitchUIMode(uiMode === "compact" ? "full" : "compact");

  const isMac = platform === "macos";

  return (
    <div
      data-tauri-drag-region
      className="fixed top-0 right-0 left-0 z-40 flex items-center border-b border-slate-200/70 bg-white/80 text-slate-700 backdrop-blur-md select-none dark:border-zinc-800/80 dark:bg-zinc-900/80 dark:text-zinc-300"
      style={{ height: `${TITLE_BAR_HEIGHT_PX}px` }}
    >
      {/* Left: traffic-light reservation (mac) or app brand (win/linux) */}
      {isMac ? (
        <div
          data-tauri-drag-region
          className="shrink-0"
          style={{ width: "80px" }}
          aria-hidden="true"
        />
      ) : (
        <div
          data-tauri-drag-region
          className="flex shrink-0 items-center gap-2 pr-3 pl-3"
        >
          <LumaIcon />
        </div>
      )}

      {/* App name */}
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-center"
      >
        <span
          data-tauri-drag-region
          className="truncate text-[12px] font-medium tracking-wide"
        >
          LumaSync
        </span>
      </div>

      {/* Right: compact toggle (+ window controls on win/linux) */}
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          data-tauri-drag-region="false"
          onClick={handleToggle}
          title={toggleTitle}
          aria-label={toggleTitle}
          className="flex h-9 w-11 items-center justify-center text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800 dark:text-zinc-400 dark:hover:bg-zinc-800/80 dark:hover:text-zinc-100"
        >
          {toggleVariant === "to-full" ? <ExpandIcon /> : <CollapseIcon />}
        </button>

        {!isMac && (
          <WindowControls
            isMaximized={isMaximized}
            onMinimize={() => void getCurrentWindow().minimize()}
            onToggleMaximize={() => void getCurrentWindow().toggleMaximize()}
            onClose={() => void getCurrentWindow().close()}
          />
        )}

        {/* Right edge padding — on mac keeps the toggle off the window corner;
            on win/linux WindowControls provides its own edge flush. */}
        {isMac && <div className="w-1" />}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Window controls (Windows / Linux)
// ────────────────────────────────────────────────────────────────

interface WindowControlsProps {
  isMaximized: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

function WindowControls({
  isMaximized,
  onMinimize,
  onToggleMaximize,
  onClose,
}: WindowControlsProps) {
  return (
    <div className="flex h-9 items-center">
      <CtrlButton onClick={onMinimize} aria="Minimize">
        <MinimizeIcon />
      </CtrlButton>
      <CtrlButton onClick={onToggleMaximize} aria={isMaximized ? "Restore" : "Maximize"}>
        {isMaximized ? <RestoreIcon /> : <MaximizeIcon />}
      </CtrlButton>
      <CtrlButton onClick={onClose} aria="Close" danger>
        <CloseIcon />
      </CtrlButton>
    </div>
  );
}

function CtrlButton({
  onClick,
  aria,
  danger,
  children,
}: {
  onClick: () => void;
  aria: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-tauri-drag-region="false"
      onClick={onClick}
      title={aria}
      aria-label={aria}
      className={`flex h-9 w-11 items-center justify-center text-slate-500 transition-colors dark:text-zinc-400 ${
        danger
          ? "hover:bg-red-500 hover:text-white"
          : "hover:bg-slate-200/70 hover:text-slate-800 dark:hover:bg-zinc-800/80 dark:hover:text-zinc-100"
      }`}
    >
      {children}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────
// Icons
// ────────────────────────────────────────────────────────────────

function LumaIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 text-slate-600 dark:text-zinc-300"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 6V1h5M15 10v5h-5M1 10v5h5M15 6V1h-5" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 1v4H1M12 15v-4h3M1 12h4v3M15 4h-4V1" />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M2 6h8" strokeLinecap="round" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="2" y="2" width="8" height="8" rx="0.5" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="2" y="3.5" width="6.5" height="6.5" rx="0.5" />
      <path d="M3.5 3.5V2h6.5v6.5H8.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
    </svg>
  );
}
