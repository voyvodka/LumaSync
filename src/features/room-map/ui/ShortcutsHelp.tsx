import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/shared/ui/IconButton/IconButton";
import { IconInfoAlt } from "@/shared/ui/icons";
import { Popover } from "@/shared/ui/Popover/Popover";

import styles from "./ShortcutsHelp.module.css";

const IS_MAC = typeof navigator !== "undefined" && navigator.platform.includes("Mac");

// The plan's own gestures, which the 3D stage's camera takes instead.
const PLAN_ONLY = new Set(["panKeyboard", "pan", "addToSelection", "boxSelect", "freeDrag"]);

/** The editor's keys, behind one button; in the 3D room, only those that work there. */
export function ShortcutsHelp({ buttonClassName, room = false }: { buttonClassName?: string; room?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();

  const mod = IS_MAC ? "⌘" : "Ctrl+";
  const shift = IS_MAC ? "⇧" : "Shift+";
  const arrows = t("roomMap:shortcuts.keys.arrows");
  const shortcuts = [
    { id: "undo", key: `${mod}Z`, desc: t("roomMap:shortcuts.undo") },
    { id: "redo", key: `${mod}${shift}Z`, desc: t("roomMap:shortcuts.redo") },
    { id: "duplicate", key: `${mod}D`, desc: t("roomMap:shortcuts.duplicate") },
    { id: "fit", key: `${mod}0`, desc: room ? t("roomMap:view.resetCamera") : t("roomMap:shortcuts.fitToView") },
    { id: "delete", key: t("roomMap:shortcuts.keys.delete"), desc: t("roomMap:shortcuts.delete") },
    { id: "rotate", key: "R", desc: t("roomMap:shortcuts.rotate") },
    { id: "deselect", key: t("roomMap:shortcuts.keys.escape"), desc: t("roomMap:shortcuts.deselect") },
    { id: "nudgeLarge", key: `${shift}${arrows}`, desc: t("roomMap:shortcuts.nudgeLarge") },
    { id: "nudge", key: arrows, desc: t("roomMap:shortcuts.nudge") },
    { id: "panKeyboard", key: arrows, desc: t("roomMap:shortcuts.panKeyboard") },
    { id: "pan", key: t("roomMap:shortcuts.keys.spaceDrag"), desc: t("roomMap:shortcuts.pan") },
    { id: "zoom", key: t("roomMap:shortcuts.scrollWheel"), desc: t("roomMap:shortcuts.zoom") },
    { id: "addToSelection", key: t("roomMap:shortcuts.keys.shiftClick", { shift }), desc: t("roomMap:shortcuts.addToSelection") },
    { id: "boxSelect", key: t("roomMap:shortcuts.keys.floorDrag"), desc: t("roomMap:shortcuts.boxSelect") },
    { id: "freeDrag", key: t("roomMap:shortcuts.keys.altDrag", { alt: IS_MAC ? "⌥" : "Alt+" }), desc: t("roomMap:shortcuts.freeDrag") },
  ].filter((s) => !room || !PLAN_ONLY.has(s.id));

  return (
    <>
      <IconButton
        ref={anchorRef}
        className={buttonClassName}
        label={t("roomMap:shortcuts.title")}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        icon={<IconInfoAlt />}
        onClick={() => setOpen((was) => !was)}
      />
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} side="below" width={240} id={id} label={t("roomMap:shortcuts.title")} role="dialog">
        <dl className={styles.list}>
          {shortcuts.map((s) => (
            <div key={s.id} className={styles.row}>
              <dt>{s.desc}</dt>
              <dd>
                <kbd>{s.key}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </Popover>
    </>
  );
}
