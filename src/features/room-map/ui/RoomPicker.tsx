import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ROOM_LAYOUTS_MAX, ROOM_NAME_MAX } from "@/shared/contracts/roomLayouts";
import { IconButton } from "@/shared/ui/IconButton/IconButton";
import { IconCheck, IconChevronDown, IconPencil, IconPlus, IconTrash } from "@/shared/ui/icons";
import { Popover } from "@/shared/ui/Popover/Popover";
import { RowNote } from "@/shared/ui/SettingRow/SettingRow";
import { SpinSwap } from "@/shared/ui/SpinSwap/SpinSwap";

import styles from "./RoomPicker.module.css";

const ARMED_MS = 3000;

export interface RoomPickerEntry {
  id: string;
  /** As shown: the stored name, or the localized default. */
  name: string;
  /** The user typed it; an unnamed room's field opens empty. */
  named: boolean;
}

export interface RoomPickerProps {
  rooms: readonly RoomPickerEntry[];
  activeId: string;
  /** A switch or a write in flight: the list still opens, a press waits. */
  busy: boolean;
  /** The last room write failed, or the open room is not saved yet. */
  failed: boolean;
  /** What just happened, read out once. */
  announce: string;
  onSwitch: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onCopy: () => void;
  /** Opens the templates over the trigger, to lay a new room out from one. */
  onFromTemplate: () => void;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

/** The room the lights follow, and the others: switched, renamed, deleted or added from here. */
export function RoomPicker({ rooms, activeId, busy, failed, announce, onSwitch, onRename, onDelete, onCopy, onFromTemplate, triggerRef }: RoomPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ownRef = useRef<HTMLButtonElement | null>(null);
  const anchorRef = triggerRef ?? ownRef;
  const listRef = useRef<HTMLDivElement | null>(null);
  const popoverId = useId();
  const active = rooms.find((room) => room.id === activeId) ?? rooms[0];
  const full = rooms.length >= ROOM_LAYOUTS_MAX;

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>("[aria-current='true']")?.focus({ preventScroll: true });
  }, [open]);

  const close = () => {
    setOpen(false);
    anchorRef.current?.focus();
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={styles.trigger}
        aria-label={t("roomMap:rooms.trigger", { name: active?.name ?? "" })}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-busy={busy || undefined}
        title={active?.name}
        onClick={() => setOpen((v) => !v)}
        data-testid="room-picker"
      >
        <span className={styles.value}>{active?.name}</span>
        <span className={styles.chevron} data-open={open || undefined} aria-hidden>
          <IconChevronDown />
        </span>
      </button>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} side="below" width={280} id={popoverId} label={t("roomMap:rooms.label")} role="dialog">
        <div ref={listRef} className={styles.panel} data-testid="room-picker-list">
          <ul className={styles.list}>
            {rooms.map((room) => (
              <RoomRow
                key={room.id}
                room={room}
                active={room.id === activeId}
                last={rooms.length <= 1}
                busy={busy}
                onSwitch={() => {
                  if (busy) return;
                  if (room.id !== activeId) onSwitch(room.id);
                  close();
                }}
                onRename={(name) => onRename(room.id, name)}
                onDelete={() => onDelete(room.id)}
              />
            ))}
          </ul>
          <div className={styles.footer}>
            <button
              type="button"
              className={styles.add}
              disabled={full || busy}
              onClick={() => {
                onCopy();
                close();
              }}
              data-testid="room-copy"
            >
              <IconPlus />
              {t("roomMap:rooms.copy")}
            </button>
            <button
              type="button"
              className={styles.add}
              disabled={full || busy}
              onClick={() => {
                setOpen(false);
                onFromTemplate();
              }}
              data-testid="room-from-template"
            >
              <IconPlus />
              {t("roomMap:rooms.fromTemplate")}
            </button>
          </div>
          {full ? (
            <RowNote tone="status" testId="room-picker-full">
              {t("roomMap:rooms.full", { max: ROOM_LAYOUTS_MAX })}
            </RowNote>
          ) : null}
          {failed ? (
            <RowNote tone="error" testId="room-picker-failed">
              {t("roomMap:rooms.saveFailed")}
            </RowNote>
          ) : null}
        </div>
      </Popover>
    </>
  );
}

function RoomRow({
  room,
  active,
  last,
  busy,
  onSwitch,
  onRename,
  onDelete,
}: {
  room: RoomPickerEntry;
  active: boolean;
  last: boolean;
  busy: boolean;
  onSwitch: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [armed, setArmed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pencilRef = useRef<HTMLButtonElement | null>(null);
  const cancelled = useRef(false);
  const hintId = useId();
  const kept = active || last;

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const finish = (keep: boolean) => {
    const byKey = document.activeElement === inputRef.current;
    setEditing(false);
    if (byKey) requestAnimationFrame(() => pencilRef.current?.focus());
    if (keep && draft.trim() !== (room.named ? room.name : "")) onRename(draft);
  };

  return (
    <li className={styles.row} data-active={active || undefined} data-testid={`room-row-${room.id}`}>
      <span className={styles.mark} aria-hidden>
        {active ? <IconCheck /> : null}
      </span>
      {editing ? (
        <input
          ref={inputRef}
          className={styles.input}
          value={draft}
          placeholder={room.name}
          maxLength={ROOM_NAME_MAX * 2}
          aria-label={t("roomMap:rooms.rename", { name: room.name })}
          aria-describedby={hintId}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              finish(true);
            } else if (event.key === "Escape") {
              // The popover closes on Escape too: this one only puts the name back.
              event.preventDefault();
              event.stopPropagation();
              cancelled.current = true;
              finish(false);
            }
          }}
          onBlur={() => {
            if (!cancelled.current) finish(true);
          }}
          data-testid={`room-name-input-${room.id}`}
        />
      ) : (
        <button
          type="button"
          className={styles.name}
          aria-current={active || undefined}
          aria-disabled={busy || undefined}
          title={room.name}
          onClick={onSwitch}
          data-testid={`room-switch-${room.id}`}
        >
          {room.name}
          {active ? <span className="sr-only">{` · ${t("roomMap:rooms.current")}`}</span> : null}
        </button>
      )}
      <span id={hintId} className="sr-only">
        {t("roomMap:rooms.renameHint")}
      </span>
      <span className={styles.actions} data-armed={armed || undefined}>
        {editing ? null : (
          <IconButton
            ref={pencilRef}
            className={styles.action}
            label={t("roomMap:rooms.rename", { name: room.name })}
            icon={<IconPencil />}
            onClick={() => {
              cancelled.current = false;
              setDraft(room.named ? room.name : "");
              setEditing(true);
            }}
            data-testid={`room-rename-${room.id}`}
          />
        )}
        <IconButton
          className={styles.action}
          label={
            kept
              ? t(last ? "roomMap:rooms.removeLast" : "roomMap:rooms.removeActive")
              : armed
                ? t("roomMap:rooms.removeConfirm", { name: room.name })
                : t("roomMap:rooms.remove", { name: room.name })
          }
          aria-disabled={kept || busy || undefined}
          icon={
            <SpinSwap
              value={armed ? "armed" : "rest"}
              turn={(value) => (value === "armed" ? "cw" : "ccw")}
              render={(value) => (value === "armed" ? <IconCheck /> : <IconTrash />)}
            />
          }
          data-danger={armed || undefined}
          onClick={() => {
            if (kept || busy) return;
            if (armed) onDelete();
            else setArmed(true);
          }}
          onBlur={() => setArmed(false)}
          onMouseLeave={() => setArmed(false)}
          data-testid={`room-remove-${room.id}`}
        />
      </span>
      <span className="sr-only" aria-live="polite">
        {armed ? t("roomMap:rooms.removeConfirm", { name: room.name }) : ""}
      </span>
    </li>
  );
}
