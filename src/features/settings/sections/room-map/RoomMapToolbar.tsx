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

  const btnBase =
    "px-2 py-1 text-[11px] font-semibold rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60";
  const btnActive =
    "text-slate-700 hover:bg-slate-100 hover:text-slate-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100";

  return (
    <div className="relative h-10 flex items-center gap-2 px-3 border-b border-slate-200/70 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 shrink-0">
      {/* Derive Zones */}
      {(() => {
        const deriveDisabled = !hasUsb || !hasTv;
        return (
          <button
            className={`${btnBase} flex items-center gap-1 ${
              deriveDisabled
                ? "opacity-40 cursor-not-allowed text-slate-500 dark:text-zinc-500"
                : derivePreviewActive
                  ? "bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100"
                  : btnActive
            }`}
            onClick={deriveDisabled ? undefined : onDeriveZones}
            disabled={deriveDisabled}
            aria-disabled={deriveDisabled}
            title={deriveDisabled ? t("roomMap.zones.deriveDisabledTooltip") : undefined}
          >
            <IconGrid />
            {t("roomMap.zones.deriveButton")}
          </button>
        );
      })()}

      {/* + Zone */}
      <button
        className={`${btnBase} ${btnActive} flex items-center`}
        onClick={onAddZone}
      >
        {t("roomMap.zones.addZoneButton")}
        {zoneCount > 0 && (
          <span className="ml-1 rounded-full bg-slate-200 dark:bg-zinc-700 px-1 text-[9px]">
            {zoneCount}
          </span>
        )}
      </button>

      {/* Separator + Undo/Redo */}
      <div className="mx-1 h-5 w-px bg-slate-200 dark:bg-zinc-700" />
      <button
        className={`${btnBase} ${canUndo ? btnActive : "opacity-30 cursor-not-allowed text-slate-500 dark:text-zinc-500"} flex items-center min-w-[28px] min-h-[28px] justify-center`}
        onClick={canUndo ? onUndo : undefined}
        disabled={!canUndo}
        aria-label={t("roomMap.toolbar.undo")}
        title={`${t("roomMap.toolbar.undo")} (${navigator.platform.includes("Mac") ? "\u2318" : "Ctrl+"}Z)`}
      >
        <IconUndo />
      </button>
      <button
        className={`${btnBase} ${canRedo ? btnActive : "opacity-30 cursor-not-allowed text-slate-500 dark:text-zinc-500"} flex items-center min-w-[28px] min-h-[28px] justify-center`}
        onClick={canRedo ? onRedo : undefined}
        disabled={!canRedo}
        aria-label={t("roomMap.toolbar.redo")}
        title={`${t("roomMap.toolbar.redo")} (${navigator.platform.includes("Mac") ? "\u2318" : "Ctrl+"}${navigator.platform.includes("Mac") ? "\u21E7" : "Shift+"}Z)`}
      >
        <IconRedo />
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Shortcuts help */}
      <ShortcutsHelpButton btnBase={btnBase} btnActive={btnActive} />

      {/* Settings gear */}
      <button
        className={`${btnBase} ${
          settingsOpen
            ? "bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100"
            : btnActive
        } flex items-center gap-1 min-w-[32px] min-h-[32px] justify-center`}
        onClick={onToggleSettings}
        aria-label={t("roomMap.toolbar.settingsAriaLabel")}
        aria-pressed={settingsOpen}
      >
        <IconGear />
      </button>
    </div>
  );
}

function ShortcutsHelpButton({ btnBase, btnActive }: { btnBase: string; btnActive: string }) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const isMac = typeof navigator !== "undefined" && navigator.platform.includes("Mac");
  const mod = isMac ? "\u2318" : "Ctrl+";
  const shift = isMac ? "\u21E7" : "Shift+";

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
        className={`${btnBase} ${open ? "bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100" : btnActive} flex items-center min-w-[28px] min-h-[28px] justify-center`}
        onClick={() => setOpen((v) => !v)}
        aria-label={t("roomMap.shortcuts.title")}
        title={t("roomMap.shortcuts.title")}
      >
        <IconInfo />
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-full mt-1 w-56 rounded-lg border border-slate-200/70 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl z-50 py-2 px-3"
        >
          <h3 className="text-[11px] font-bold text-slate-700 dark:text-zinc-200 mb-1.5">
            {t("roomMap.shortcuts.title")}
          </h3>
          <div className="space-y-1">
            {shortcuts.map((s) => (
              <div key={s.key} className="flex items-center justify-between text-[10px]">
                <span className="text-slate-500 dark:text-zinc-400">{s.desc}</span>
                <kbd className="ml-2 rounded bg-slate-100 dark:bg-zinc-800 px-1 py-0.5 text-[9px] font-mono text-slate-600 dark:text-zinc-300 whitespace-nowrap">
                  {s.key}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
