import { useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/shared/ui/Button";

import { IconGear, IconUndo, IconRedo, IconInfoAlt } from "@/shared/ui/icons";
import type { RoomAwareStatus } from "../model/roomAware";
import { RoomAwareIndicator } from "./RoomAwareIndicator";

interface RoomMapToolbarProps {
  settingsOpen: boolean;
  onToggleSettings: () => void;
  roomAware?: RoomAwareStatus | null;
  zoneCount?: number;
  onAddZone?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
}

/* Shared button styling — amber Rev 07 tokens, 32px tap floor */
const TOOLBAR_BTN = "lm-room-toolbar-btn";

export function RoomMapToolbar({
  settingsOpen,
  onToggleSettings,
  roomAware = null,
  zoneCount = 0,
  onAddZone = () => {},
  canUndo = false,
  canRedo = false,
  onUndo = () => {},
  onRedo = () => {},
}: RoomMapToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="lm-room-toolbar shrink-0">
      {/* + Zone */}
      <button type="button" className={TOOLBAR_BTN} onClick={onAddZone}>
        <span>{t("roomMap:zones.addZoneButton")}</span>
        {zoneCount > 0 && <span className="lm-room-toolbar-badge">{zoneCount}</span>}
      </button>

      <span className="lm-room-toolbar-sep" aria-hidden />

      {/* Undo / Redo */}
      <IconButton
        className={`${TOOLBAR_BTN} is-icon ${!canUndo ? "is-disabled" : ""}`}
        onClick={canUndo ? onUndo : undefined}
        aria-disabled={!canUndo}
        label={t("roomMap:toolbar.undo")}
        title={`${t("roomMap:toolbar.undo")} (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}Z)`}
        icon={<IconUndo />}
      />
      <IconButton
        className={`${TOOLBAR_BTN} is-icon ${!canRedo ? "is-disabled" : ""}`}
        onClick={canRedo ? onRedo : undefined}
        aria-disabled={!canRedo}
        label={t("roomMap:toolbar.redo")}
        title={`${t("roomMap:toolbar.redo")} (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}${navigator.platform.includes("Mac") ? "⇧" : "Shift+"}Z)`}
        icon={<IconRedo />}
      />

      <div className="flex-1" />

      {roomAware && <RoomAwareIndicator variant="popover" status={roomAware} />}

      <ShortcutsHelpButton />

      <IconButton
        className={`${TOOLBAR_BTN} is-icon`}
        onClick={onToggleSettings}
        label={t("roomMap:toolbar.settingsAriaLabel")}
        aria-pressed={settingsOpen}
        icon={<IconGear />}
      />
    </div>
  );
}

function ShortcutsHelpButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const isMac = typeof navigator !== "undefined" && navigator.platform.includes("Mac");
  const mod = isMac ? "⌘" : "Ctrl+";
  const shift = isMac ? "⇧" : "Shift+";

  const shortcuts = [
    { key: `${mod}Z`, desc: t("roomMap:shortcuts.undo") },
    { key: `${mod}${shift}Z`, desc: t("roomMap:shortcuts.redo") },
    { key: `${mod}D`, desc: t("roomMap:shortcuts.duplicate") },
    { key: `${mod}0`, desc: t("roomMap:shortcuts.fitToView") },
    { key: "Delete", desc: t("roomMap:shortcuts.delete") },
    { key: "R", desc: t("roomMap:shortcuts.rotate") },
    { key: "F", desc: t("roomMap:shortcuts.togglePanel") },
    { key: "Escape", desc: t("roomMap:shortcuts.deselect") },
    { key: `${shift}Arrow`, desc: t("roomMap:shortcuts.nudgeLarge") },
    { key: "Arrow", desc: t("roomMap:shortcuts.nudge") },
    { key: "Arrow", desc: t("roomMap:shortcuts.panKeyboard") },
    { key: "Space+Drag", desc: t("roomMap:shortcuts.pan") },
    { key: t("roomMap:shortcuts.scrollWheel"), desc: t("roomMap:shortcuts.zoom") },
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
      <IconButton
        ref={btnRef}
        className={`${TOOLBAR_BTN} is-icon`}
        onClick={() => setOpen((v) => !v)}
        label={t("roomMap:shortcuts.title")}
        aria-expanded={open}
        icon={<IconInfoAlt />}
      />
      {open && (
        <div
          ref={popoverRef}
          className="lm-room-toolbar-popover"
          role="dialog"
          aria-modal="false"
          aria-label={t("roomMap:shortcuts.title")}
        >
          <h3 className="lm-room-toolbar-popover-h">
            {t("roomMap:shortcuts.title")}
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
