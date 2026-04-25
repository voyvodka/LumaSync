import { useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

function IconGear() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" />
    </svg>
  );
}

function IconGrid() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="1" y="1" width="6" height="6" rx="0.5" />
      <rect x="9" y="1" width="6" height="6" rx="0.5" />
      <rect x="1" y="9" width="6" height="6" rx="0.5" />
      <rect x="9" y="9" width="6" height="6" rx="0.5" />
    </svg>
  );
}

function IconUndo() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h7a3 3 0 1 1 0 6H9" />
      <path d="M6 3L3 6l3 3" />
    </svg>
  );
}

function IconRedo() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 6H6a3 3 0 1 0 0 6h1" />
      <path d="M10 3l3 3-3 3" />
    </svg>
  );
}

function IconInfo() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 7v4" />
      <circle cx="8" cy="5" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

interface RoomMapToolbarProps {
  settingsOpen: boolean;
  onToggleSettings: () => void;
  hasTv?: boolean;
  hasUsb?: boolean;
  derivePreviewActive?: boolean;
  zoneCount?: number;
  onDeriveZones?: () => void;
  onAddZone?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
}

/* Shared button styling — amber Rev 07 tokens, 32px tap floor */
const TOOLBAR_BTN =
  "lm-room-toolbar-btn focus-visible:outline-none";

export function RoomMapToolbar({
  settingsOpen,
  onToggleSettings,
  hasTv = false,
  hasUsb = false,
  derivePreviewActive = false,
  zoneCount = 0,
  onDeriveZones = () => {},
  onAddZone = () => {},
  canUndo = false,
  canRedo = false,
  onUndo = () => {},
  onRedo = () => {},
}: RoomMapToolbarProps) {
  const { t } = useTranslation("common");
  const deriveDisabled = !hasUsb || !hasTv;

  return (
    <div className="lm-room-toolbar shrink-0">
      {/* Derive Zones */}
      <button
        type="button"
        className={`${TOOLBAR_BTN} ${
          deriveDisabled ? "is-disabled" : derivePreviewActive ? "is-on" : ""
        }`}
        onClick={deriveDisabled ? undefined : onDeriveZones}
        disabled={deriveDisabled}
        aria-disabled={deriveDisabled}
        title={deriveDisabled ? t("roomMap.zones.deriveDisabledTooltip") : undefined}
      >
        <IconGrid />
        <span>{t("roomMap.zones.deriveButton")}</span>
      </button>

      {/* + Zone */}
      <button type="button" className={TOOLBAR_BTN} onClick={onAddZone}>
        <span>{t("roomMap.zones.addZoneButton")}</span>
        {zoneCount > 0 && <span className="lm-room-toolbar-badge">{zoneCount}</span>}
      </button>

      <span className="lm-room-toolbar-sep" aria-hidden />

      {/* Undo / Redo */}
      <button
        type="button"
        className={`${TOOLBAR_BTN} is-icon ${!canUndo ? "is-disabled" : ""}`}
        onClick={canUndo ? onUndo : undefined}
        disabled={!canUndo}
        aria-label={t("roomMap.toolbar.undo")}
        title={`${t("roomMap.toolbar.undo")} (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}Z)`}
      >
        <IconUndo />
      </button>
      <button
        type="button"
        className={`${TOOLBAR_BTN} is-icon ${!canRedo ? "is-disabled" : ""}`}
        onClick={canRedo ? onRedo : undefined}
        disabled={!canRedo}
        aria-label={t("roomMap.toolbar.redo")}
        title={`${t("roomMap.toolbar.redo")} (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}${navigator.platform.includes("Mac") ? "⇧" : "Shift+"}Z)`}
      >
        <IconRedo />
      </button>

      <div className="flex-1" />

      <ShortcutsHelpButton />

      <button
        type="button"
        className={`${TOOLBAR_BTN} is-icon ${settingsOpen ? "is-on" : ""}`}
        onClick={onToggleSettings}
        aria-label={t("roomMap.toolbar.settingsAriaLabel")}
        aria-pressed={settingsOpen}
      >
        <IconGear />
      </button>
    </div>
  );
}

function ShortcutsHelpButton() {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const isMac = typeof navigator !== "undefined" && navigator.platform.includes("Mac");
  const mod = isMac ? "⌘" : "Ctrl+";
  const shift = isMac ? "⇧" : "Shift+";

  const shortcuts = [
    { key: `${mod}Z`, desc: t("roomMap.shortcuts.undo") },
    { key: `${mod}${shift}Z`, desc: t("roomMap.shortcuts.redo") },
    { key: `${mod}D`, desc: t("roomMap.shortcuts.duplicate") },
    { key: `${mod}0`, desc: t("roomMap.shortcuts.fitToView") },
    { key: "Delete", desc: t("roomMap.shortcuts.delete") },
    { key: "R", desc: t("roomMap.shortcuts.rotate") },
    { key: "F", desc: t("roomMap.shortcuts.togglePanel") },
    { key: "Escape", desc: t("roomMap.shortcuts.deselect") },
    { key: `${shift}Arrow`, desc: t("roomMap.shortcuts.nudgeLarge") },
    { key: "Arrow", desc: t("roomMap.shortcuts.nudge") },
    { key: "Space+Drag", desc: t("roomMap.shortcuts.pan") },
    { key: t("roomMap.shortcuts.scrollWheel"), desc: t("roomMap.shortcuts.zoom") },
  ];

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        className={`${TOOLBAR_BTN} is-icon ${open ? "is-on" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={t("roomMap.shortcuts.title")}
        aria-expanded={open}
        title={t("roomMap.shortcuts.title")}
      >
        <IconInfo />
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="lm-room-toolbar-popover"
          role="dialog"
          aria-modal="false"
          aria-label={t("roomMap.shortcuts.title")}
        >
          <h3 className="lm-room-toolbar-popover-h">
            {t("roomMap.shortcuts.title")}
          </h3>
          <div className="lm-room-toolbar-popover-body">
            {shortcuts.map((s) => (
              <div key={s.key} className="lm-room-toolbar-popover-row">
                <span>{s.desc}</span>
                <kbd>{s.key}</kbd>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
