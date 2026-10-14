import { type ReactNode, type Ref, useState } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "@/shared/lib/cx";
import { Callout, type CalloutAction, type CalloutTone } from "@/shared/ui/Callout/Callout";
import { IconButton } from "@/shared/ui/IconButton/IconButton";
import { IconClose, IconLockClosed, IconLockOpen, IconTrash } from "@/shared/ui/icons";

import { IconDuplicate } from "./dockIcons";
import styles from "./InspectorParts.module.css";

/** An inspector's two rows: who it is and what to do with it, then its numbers. */
export function InspectorRows({ first, second }: { first: ReactNode; second: ReactNode }) {
  return (
    <div className={styles.rows}>
      <div className={styles.row}>{first}</div>
      <div className={styles.row}>{second}</div>
    </div>
  );
}

/** What the selection is, at a glance: a 24 px drawing, icon or disc. */
export function Mark({ children }: { children: ReactNode }) {
  return (
    <span className={styles.mark} aria-hidden="true">
      {children}
    </span>
  );
}

/** A name that reads as text at rest and edits in place: Enter or leaving keeps it, Esc puts it
 *  back, and an empty one returns to what it was. */
export function NameField({
  value,
  fallback,
  label,
  disabled = false,
  first = false,
  onCommit,
}: {
  /** The stored name; `undefined` shows `fallback`. */
  value: string | undefined;
  fallback: string;
  label: string;
  disabled?: boolean;
  /** Takes focus when the inspector opens from the keyboard. */
  first?: boolean;
  onCommit: (name: string) => void;
}) {
  const shown = value ?? fallback;
  const [draft, setDraft] = useState(shown);
  const [editing, setEditing] = useState(false);
  if (!editing && draft !== shown) setDraft(shown);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft(shown);
      return;
    }
    if (trimmed !== shown) onCommit(trimmed);
  };

  return (
    <input
      type="text"
      className={styles.name}
      aria-label={label}
      title={shown}
      value={draft}
      disabled={disabled}
      spellCheck={false}
      data-dock-first={first || undefined}
      onFocus={(e) => {
        setEditing(true);
        // Typing replaces the name, as it replaces a number.
        e.currentTarget.select();
      }}
      onChange={(e) => {
        setEditing(true);
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          setDraft(shown);
          setEditing(false);
        }
      }}
    />
  );
}

/** A fixed label where the kind has no name of its own to edit. */
export function Title({ children }: { children: ReactNode }) {
  return <span className={styles.title}>{children}</span>;
}

/** A Hue light or zone as a disc: a light drawn as the plan draws it, a zone filled with its colour,
 *  and a light the bridge no longer reports as a dashed ring. */
export function Disc({ fill, ring, ghost = false, children }: { fill?: string; ring?: string; ghost?: boolean; children?: ReactNode }) {
  return (
    <span
      className={cx(styles.disc, ghost && styles.discGhost)}
      style={{ background: ghost ? undefined : fill, boxShadow: ring ? `0 0 0 2px ${ring}` : undefined }}
    >
      {children}
    </span>
  );
}

/** A one-line note in a row: the short word on the line, the full sentence as its tooltip. */
export function Note({
  tone,
  title,
  action,
  ref,
  children,
}: {
  tone: CalloutTone;
  title?: string;
  action?: CalloutAction;
  ref?: Ref<HTMLSpanElement>;
  children: ReactNode;
}) {
  return (
    <span ref={ref} className={styles.note} title={title}>
      <Callout tone={tone} announce={false} action={action} className={styles.noteCallout}>
        {children}
      </Callout>
    </span>
  );
}

/** A connection in a word and the address it is on, in a slot of fixed width. */
export function Status({ children }: { children: ReactNode }) {
  return <span className={styles.status}>{children}</span>;
}

/** A quiet text action in a row. */
export function RowLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className={styles.link} onClick={onClick}>
      {children}
    </button>
  );
}

/** A small fact beside the name, whole in its tooltip when the row cuts it short. */
export function Meta({ children }: { children: string }) {
  return (
    <span className={styles.meta} title={children}>
      {children}
    </span>
  );
}

/** Takes the row's spare width, so what follows sits at its end. */
export function Spacer() {
  return <span className={styles.spacer} aria-hidden="true" />;
}

/** The selection's actions at the end of the first row. A kind that cannot be duplicated or
 *  deleted leaves the button out rather than showing it dead. */
export function Actions({
  locked,
  onToggleLock,
  onDuplicate,
  onDelete,
  onClose,
}: {
  locked: boolean;
  onToggleLock?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <span className={styles.actions}>
      {onToggleLock && (
        <IconButton
          className={styles.action}
          label={t("roomMap:objectPanel.lock")}
          title={locked ? t("roomMap:objectPanel.unlock") : t("roomMap:objectPanel.lock")}
          aria-pressed={locked}
          icon={locked ? <IconLockClosed /> : <IconLockOpen />}
          onClick={onToggleLock}
        />
      )}
      {onDuplicate && (
        <IconButton className={styles.action} label={t("roomMap:contextMenu.duplicate")} icon={<IconDuplicate />} onClick={onDuplicate} />
      )}
      {onDelete && (
        <IconButton
          className={cx(styles.action, styles.danger)}
          label={t("roomMap:objectPanel.delete")}
          icon={<IconTrash />}
          disabled={locked}
          onClick={onDelete}
        />
      )}
      <IconButton className={styles.action} label={t("roomMap:dock.close")} icon={<IconClose />} onClick={onClose} />
    </span>
  );
}

/** Numbers side by side, each taking an equal share of the row. */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className={styles.fields}>{children}</div>;
}
