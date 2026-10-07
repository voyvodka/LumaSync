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

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  closeCurrentWindow,
  isCurrentWindowMaximized,
  minimizeCurrentWindow,
  onCurrentWindowResized,
  toggleMaximizeCurrentWindow,
} from "./windowApi";
import { SECTION_ORDER, type SectionId } from "@/shared/contracts/shell";
import styles from "./TitleBar.module.css";

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
  /** Active navigation tab — only relevant in full mode. */
  activeSection?: SectionId;
  /** Called when user clicks a tab — only relevant in full mode. */
  onSectionChange?: (id: SectionId) => void;
  /**
   * A prompt owns the window (the update prompt): the tabs and the mode toggle
   * step back and take no input. The bar itself stays live — it is the drag
   * region and holds the window controls, which is why no scrim covers it.
   */
  navLocked?: boolean;
}

export const TITLE_BAR_HEIGHT_PX = 36;

/** The page the section tabs switch: the tabs name it as what they control. */
export const SECTION_PANEL_ID = "lm-section-panel";

export function TitleBar({ uiMode, onSwitchUIMode, activeSection, onSectionChange, navLocked = false }: TitleBarProps) {
  const { t } = useTranslation();
  const [platform] = useState<Platform>(detectPlatform);
  const [isMaximized, setIsMaximized] = useState(false);

  // Track native maximize state so the toggle icon stays in sync with the
  // actual window (double-click, Win+Up, etc. all bypass our button).
  useEffect(() => {
    if (platform === "macos") return;
    let unlisten: (() => void) | undefined;
    void isCurrentWindowMaximized().then(setIsMaximized);
    void onCurrentWindowResized(() => {
      void isCurrentWindowMaximized().then(setIsMaximized);
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
    toggleVariant === "to-full" ? "settings:nav.switchToFull" : "settings:nav.switchToCompact",
  );
  const handleToggle = () => void onSwitchUIMode(uiMode === "compact" ? "full" : "compact");

  const isMac = platform === "macos";

  return (
    <div
      data-tauri-drag-region
      className={`${styles.bar} fixed top-0 right-0 left-0 z-40 flex items-center select-none`}
      style={{
        height: `${TITLE_BAR_HEIGHT_PX}px`,
        gap: "20px",
        // On win/linux the custom min/max/close buttons own the edge and should
        // sit flush against it; on mac the compact toggle needs the inset.
        paddingRight: isMac ? "10px" : "0",
      }}
    >
      {/* Left: traffic-light reservation (mac) or leading brand mark (win/linux).
          Mac keeps a hard 80px reservation so native traffic lights never
          collide with our drag region; win/linux gets a small amber LumaIcon
          where the system would normally draw its own icon. */}
      {isMac ? (
        <div
          data-tauri-drag-region
          className="shrink-0"
          style={{ width: "80px", height: "100%" }}
          aria-hidden="true"
        />
      ) : (
        <div
          data-tauri-drag-region
          className="flex shrink-0 items-center pr-1 pl-3"
        >
          <LumaIcon />
        </div>
      )}

      {/* Brand — `LUMA/SYNC` with an amber slash, IBM Plex Mono. */}
      <div data-tauri-drag-region className="flex shrink-0 items-center">
        <span data-tauri-drag-region className={styles.brand}>
          LUMA<span className={styles.accent}>/</span>SYNC
        </span>
      </div>

      {/* Nav tabs — full mode only, between brand and spacer. */}
      {uiMode === "full" && activeSection != null && onSectionChange != null && (
        <SectionTabs active={activeSection} onChange={onSectionChange} locked={navLocked} />
      )}

      {/* Spacer — pushes right cluster to the edge. */}
      <div data-tauri-drag-region className="min-w-0 flex-1" />

      {/* Right cluster: compact/full toggle (+ window controls on win/linux). */}
      <div className="flex shrink-0 items-center" style={{ height: "100%" }}>
        <button
          type="button"
          data-tauri-drag-region="false"
          onClick={handleToggle}
          title={toggleTitle}
          aria-label={toggleTitle}
          className={styles.toggle}
          inert={navLocked}
          data-locked={navLocked || undefined}
          data-testid="ui-mode-toggle"
        >
          {toggleVariant === "to-full" ? <ExpandIcon /> : <CollapseIcon />}
        </button>

        {!isMac && (
          <>
            {/* small breathing room between toggle and native-replacement controls */}
            <span aria-hidden className="inline-block" style={{ width: "8px" }} />
            <WindowControls
              isMaximized={isMaximized}
              onMinimize={() => void minimizeCurrentWindow()}
              onToggleMaximize={() => void toggleMaximizeCurrentWindow()}
              onClose={() => void closeCurrentWindow()}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Section tabs
// ────────────────────────────────────────────────────────────────

const STEP_BY_KEY: Record<string, 1 | -1> = { ArrowRight: 1, ArrowLeft: -1 };

/**
 * The sections as a WAI-ARIA tablist: one tab stop, the arrows move focus and Enter or Space opens,
 * so an arrow does not leave a page (and ask about its unsaved work) on the way past it. One amber
 * mark under the open tab slides to the next.
 */
/** `.tab`'s side padding in the module, and the mark's floor. */
const TAB_PADDING = 11;
const MARK_MIN_WIDTH = 36;

function SectionTabs({
  active,
  onChange,
  locked,
}: {
  active: SectionId;
  onChange: (id: SectionId) => void;
  locked: boolean;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  const markRef = useRef<HTMLSpanElement | null>(null);

  // Measured, not laid out: a tab's width follows its word, so a language switch re-measures through
  // the observer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the active tab is what moves the mark
  useLayoutEffect(() => {
    const list = listRef.current;
    const mark = markRef.current;
    if (!list || !mark) return undefined;
    const place = () => {
      const tab = list.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!tab) return;
      // As wide as the word, but never a stub under a short one ("Oda").
      const width = Math.max(tab.offsetWidth - TAB_PADDING * 2, MARK_MIN_WIDTH);
      mark.style.width = `${width}px`;
      mark.style.transform = `translateX(${tab.offsetLeft + (tab.offsetWidth - width) / 2}px)`;
    };
    place();
    const frame = requestAnimationFrame(() => {
      mark.dataset.placed = "";
    });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(list);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    const at = tabs.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    const step = STEP_BY_KEY[event.key];
    const next =
      step !== undefined
        ? tabs[(at + step + tabs.length) % tabs.length]
        : event.key === "Home"
          ? tabs[0]
          : event.key === "End"
            ? tabs[tabs.length - 1]
            : undefined;
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <div
      ref={listRef}
      className={styles.tabs}
      role="tablist"
      aria-label={t("shell:titleBar.sectionsAriaLabel")}
      inert={locked}
      data-locked={locked || undefined}
      onKeyDown={onKeyDown}
    >
      {SECTION_ORDER.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          data-tauri-drag-region="false"
          className={styles.tab}
          aria-selected={id === active}
          aria-controls={id === active ? SECTION_PANEL_ID : undefined}
          tabIndex={id === active ? 0 : -1}
          onClick={() => onChange(id)}
          data-testid={`section-tab-${id}`}
        >
          {t(`settings:nav.sections.${id}`)}
        </button>
      ))}
      <span ref={markRef} className={styles.indicator} aria-hidden />
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
  const { t } = useTranslation();
  return (
    <div className="flex h-9 items-center">
      <CtrlButton onClick={onMinimize} aria={t("shell:titleBar.minimize")}>
        <MinimizeIcon />
      </CtrlButton>
      <CtrlButton
        onClick={onToggleMaximize}
        aria={isMaximized ? t("shell:titleBar.restore") : t("shell:titleBar.maximize")}
      >
        {isMaximized ? <RestoreIcon /> : <MaximizeIcon />}
      </CtrlButton>
      <CtrlButton onClick={onClose} aria={t("shell:titleBar.close")} danger>
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
      className={danger ? `${styles.ctrl} ${styles.danger}` : styles.ctrl}
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
      className={styles.mark}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
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
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 6V1h5M15 10v5h-5M1 10v5h5M15 6V1h-5" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 1v4H1M12 15v-4h3M1 12h4v3M15 4h-4V1" />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <path d="M2 6h8" strokeLinecap="round" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="2" y="2" width="8" height="8" rx="0.5" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="2" y="3.5" width="6.5" height="6.5" rx="0.5" />
      <path d="M3.5 3.5V2h6.5v6.5H8.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
    </svg>
  );
}
