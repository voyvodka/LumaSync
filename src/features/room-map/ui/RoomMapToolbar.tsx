import { useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/shared/ui/IconButton/IconButton";

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

  const arrows = t("roomMap:shortcuts.keys.arrows");
  const shortcuts = [
    { id: "undo", key: `${mod}Z`, desc: t("roomMap:shortcuts.undo") },
    { id: "redo", key: `${mod}${shift}Z`, desc: t("roomMap:shortcuts.redo") },
    { id: "duplicate", key: `${mod}D`, desc: t("roomMap:shortcuts.duplicate") },
    { id: "fit", key: `${mod}0`, desc: t("roomMap:shortcuts.fitToView") },
    { id: "delete", key: t("roomMap:shortcuts.keys.delete"), desc: t("roomMap:shortcuts.delete") },
    { id: "rotate", key: "R", desc: t("roomMap:shortcuts.rotate") },
    { id: "panel", key: "F", desc: t("roomMap:shortcuts.togglePanel") },
    { id: "deselect", key: t("roomMap:shortcuts.keys.escape"), desc: t("roomMap:shortcuts.deselect") },
    { id: "nudgeLarge", key: `${shift}${arrows}`, desc: t("roomMap:shortcuts.nudgeLarge") },
    { id: "nudge", key: arrows, desc: t("roomMap:shortcuts.nudge") },
    { id: "panKeyboard", key: arrows, desc: t("roomMap:shortcuts.panKeyboard") },
    { id: "pan", key: t("roomMap:shortcuts.keys.spaceDrag"), desc: t("roomMap:shortcuts.pan") },
    { id: "zoom", key: t("roomMap:shortcuts.scrollWheel"), desc: t("roomMap:shortcuts.zoom") },
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
              <div key={s.id} className="lm-room-toolbar-popover-row">
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
