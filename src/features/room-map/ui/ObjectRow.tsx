import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { canDeleteObjectKind } from "../model/objectCapability";

import { IconLockClosed, IconLockOpen } from "@/shared/ui/icons";
import type { ObjectRowEntry } from "../model/objectList";

export function ObjectRow({
  entry,
  selected,
  nested,
  dotColor,
  onSelect,
  onDelete,
  onRename,
  onToggleLock,
}: {
  entry: ObjectRowEntry;
  selected: boolean;
  nested?: boolean;
  dotColor: string;
  onSelect: () => void;
  onDelete: () => void;
  onRename?: (label: string) => void;
  onToggleLock: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  const startEdit = useCallback(() => {
    if (!onRename) return;
    setEditing(true);
    setEditValue(entry.label);
  }, [onRename, entry.label]);

  const commit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== entry.label) onRename?.(trimmed);
    setEditing(false);
  }, [editValue, entry.label, onRename]);

  return (
    <li
      className={["lm-room-dock-row", selected ? "is-on" : "", nested ? "is-nested" : ""]
        .filter(Boolean)
        .join(" ")}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="lm-room-dock-row-dot" style={{ background: dotColor }} aria-hidden />
      {editing ? (
        <input
          autoFocus
          className="lm-room-dock-row-edit"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="lm-room-dock-row-label"
          onDoubleClick={(e) => {
            e.stopPropagation();
            startEdit();
          }}
        >
          {entry.label}
        </span>
      )}
      <button
        type="button"
        className="lm-room-dock-row-action"
        aria-label={entry.locked ? t("roomMap:objectPanel.unlock") : t("roomMap:objectPanel.lock")}
        title={entry.locked ? t("roomMap:objectPanel.unlock") : t("roomMap:objectPanel.lock")}
        onClick={(e) => {
          e.stopPropagation();
          onToggleLock();
        }}
      >
        {entry.locked ? <IconLockClosed /> : <IconLockOpen />}
      </button>
      {/*
        v1.5 W4-F2 manual-test feedback (2026-04-28): Hue channels are
        bridge-managed and cannot be deleted from the LumaSync side, so
        the delete (×) button is hidden for `type === "hue"` rows. Zone
        detach for a Hue channel goes through the Hue Zones tab's
        "Move to → Unassigned" affordance instead.
      */}
      {!entry.locked && canDeleteObjectKind(entry.type) && (
        <button
          type="button"
          className="lm-room-dock-row-action is-danger"
          aria-label={t("roomMap:objectPanel.delete")}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          ×
        </button>
      )}
    </li>
  );
}
