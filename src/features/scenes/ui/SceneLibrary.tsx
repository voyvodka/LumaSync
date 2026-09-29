import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { SCENE_LIMITS, type StoredScene, type SuggestedSceneId } from "@/shared/contracts/scenes";
import { IconButton } from "@/shared/ui/IconButton/IconButton";
import { IconCheck, IconChevronDown, IconChevronUp, IconPencil, IconPlus, IconTrash } from "@/shared/ui/icons";
import { RowNote } from "@/shared/ui/SettingRow/SettingRow";

import {
  SUGGESTED_SCENE_ORDER,
  isSceneAvailable,
  sceneName,
  sceneSwatch,
  suggestedScene,
  withScene,
  withSceneMoved,
  withSceneName,
  withoutScene,
} from "../model/sceneLibrary";
import { editScenes } from "../state/scenesStore";
import styles from "./SceneLibrary.module.css";

/** How long a delete waits for its second press: the webview does not always blur a clicked button. */
const ARMED_MS = 3000;

interface SceneLibraryProps {
  scenes: readonly StoredScene[];
  /** The button that opened it: focus goes back there when focus leaves the library. */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

/**
 * The library popover: the user's scenes to rename, reorder and delete, then the suggested ones not
 * yet in the list to add. A row's actions show on hover or focus; nothing moves when they do. It is
 * portalled after the page, so it takes focus when it opens and closes when focus leaves it.
 */
export function SceneLibrary({ scenes, anchorRef, onClose }: SceneLibraryProps) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inList = new Set(scenes.map((scene) => scene.suggestedId).filter(Boolean));
  const suggestions = SUGGESTED_SCENE_ORDER.filter((id) => !inList.has(id));
  const full = scenes.length >= SCENE_LIMITS.maxScenes;

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  /** After an edit re-renders the list: the control named, else the library itself. */
  const refocus = (testId?: string) =>
    requestAnimationFrame(() => {
      const target = testId ? rootRef.current?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) : null;
      (target ?? rootRef.current)?.focus({ preventScroll: true });
    });

  const edit = (change: (list: readonly StoredScene[]) => StoredScene[], focusAfter?: string) => {
    setFailed(false);
    void editScenes(change).catch((error: unknown) => {
      console.error("[LumaSync] saving the scenes failed:", error);
      setFailed(true);
    });
    refocus(focusAfter);
  };
  const add = (suggestedId: SuggestedSceneId) => {
    const scene = suggestedScene(suggestedId, crypto.randomUUID());
    edit((list) => withScene(list, scene));
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={styles.library}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && (rootRef.current?.contains(next) || anchorRef.current?.contains(next))) return;
        // Tabbing past either end leaves the page for the popover's portal: close, and go home.
        onClose();
        if (!next) anchorRef.current?.focus();
      }}
      data-testid="scene-library"
    >
      <h3 className={styles.heading}>{t("lights:scenes.yours")}</h3>
      {scenes.length === 0 ? (
        <p className={styles.empty}>{t("lights:scenes.empty")}</p>
      ) : (
        <ul className={styles.list} data-testid="scene-library-yours">
          {scenes.map((scene, index) => (
            <SceneEntry
              key={scene.id}
              scene={scene}
              first={index === 0}
              last={index === scenes.length - 1}
              onRename={(name) => edit((list) => withSceneName(list, scene.id, name), `scene-rename-${scene.id}`)}
              onMove={(delta) =>
                edit(
                  (list) => withSceneMoved(list, scene.id, delta),
                  `scene-${delta < 0 ? "up" : "down"}-${scene.id}`,
                )
              }
              onRemove={() => edit((list) => withoutScene(list, scene.id))}
            />
          ))}
        </ul>
      )}
      {suggestions.length > 0 ? (
        <>
          <h3 className={styles.heading}>{t("lights:scenes.suggestedTitle")}</h3>
          {full ? (
            <RowNote tone="status" testId="scene-library-full">
              {t("lights:scenes.full", { max: SCENE_LIMITS.maxScenes })}
            </RowNote>
          ) : null}
          <ul className={styles.list} data-testid="scene-library-suggested">
            {suggestions.map((suggestedId) => {
              const preview = suggestedScene(suggestedId, suggestedId);
              const name = sceneName(preview, t);
              return (
                <li key={suggestedId} className={styles.row}>
                  <span className={styles.swatch} style={{ background: sceneSwatch(preview) }} aria-hidden />
                  <span className={styles.name}>{name}</span>
                  <IconButton
                    className={styles.action}
                    label={t("lights:scenes.add", { name })}
                    icon={<IconPlus />}
                    disabled={full}
                    onClick={() => add(suggestedId)}
                    data-testid={`scene-add-${suggestedId}`}
                  />
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {failed ? (
        <RowNote tone="error" testId="scene-library-failed">
          {t("lights:scenes.saveFailed")}
        </RowNote>
      ) : null}
    </div>
  );
}

interface SceneEntryProps {
  scene: StoredScene;
  first: boolean;
  last: boolean;
  onRename: (name: string) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}

/** One of the user's scenes: its name renamed in place, moved a place, or deleted on a second press. */
function SceneEntry({ scene, first, last, onRename, onMove, onRemove }: SceneEntryProps) {
  const { t } = useTranslation();
  const name = sceneName(scene, t);
  const available = isSceneAvailable(scene);
  const noteId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [armed, setArmed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const renameRef = useRef<HTMLButtonElement | null>(null);
  // Enter closes the field and its blur would close it again; Esc closes it keeping nothing.
  const fieldOpen = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const open = () => {
    fieldOpen.current = true;
    setDraft(scene.name ?? "");
    setEditing(true);
  };
  const close = (keep: boolean) => {
    if (!fieldOpen.current) return;
    fieldOpen.current = false;
    const byKey = document.activeElement === inputRef.current;
    setEditing(false);
    if (keep && draft.trim() !== (scene.name ?? "")) onRename(draft);
    else if (byKey) requestAnimationFrame(() => renameRef.current?.focus());
  };

  return (
    <li className={styles.row} data-unavailable={!available || undefined} data-testid={`scene-entry-${scene.id}`}>
      <span className={styles.swatch} style={{ background: sceneSwatch(scene) }} aria-hidden />
      {editing ? (
        <input
          ref={inputRef}
          autoFocus
          className={styles.input}
          value={draft}
          placeholder={name}
          maxLength={SCENE_LIMITS.nameMaxCodePoints * 2}
          aria-label={t("lights:scenes.rename", { name })}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              close(true);
            } else if (event.key === "Escape") {
              // The popover would close on the same key.
              event.preventDefault();
              event.stopPropagation();
              close(false);
            }
          }}
          onBlur={() => close(true)}
          data-testid={`scene-name-input-${scene.id}`}
        />
      ) : (
        <span className={styles.name}>
          {name}
          {available ? null : (
            <span id={noteId} className={styles.note}>
              {" · "}
              {t("lights:scenes.unavailableShort")}
            </span>
          )}
        </span>
      )}
      <span className={styles.actions} data-armed={armed || undefined}>
        <IconButton
          ref={renameRef}
          className={styles.action}
          label={t("lights:scenes.rename", { name })}
          icon={<IconPencil />}
          onClick={open}
          data-testid={`scene-rename-${scene.id}`}
        />
        {/* aria-disabled, not disabled: a move to the edge keeps focus on the button it pressed. */}
        <IconButton
          className={styles.action}
          label={t("lights:scenes.moveUp", { name })}
          icon={<IconChevronUp />}
          aria-disabled={first || undefined}
          onClick={() => {
            if (!first) onMove(-1);
          }}
          data-testid={`scene-up-${scene.id}`}
        />
        <IconButton
          className={styles.action}
          label={t("lights:scenes.moveDown", { name })}
          icon={<IconChevronDown />}
          aria-disabled={last || undefined}
          onClick={() => {
            if (!last) onMove(1);
          }}
          data-testid={`scene-down-${scene.id}`}
        />
        <IconButton
          className={styles.action}
          label={armed ? t("lights:scenes.removeConfirm", { name }) : t("lights:scenes.remove", { name })}
          icon={armed ? <IconCheck /> : <IconTrash />}
          aria-describedby={available ? undefined : noteId}
          data-danger={armed || undefined}
          onClick={() => (armed ? onRemove() : setArmed(true))}
          onBlur={() => setArmed(false)}
          onMouseLeave={() => setArmed(false)}
          data-testid={`scene-remove-${scene.id}`}
        />
      </span>
      <span className="sr-only" aria-live="polite">
        {armed ? t("lights:scenes.removeConfirm", { name }) : ""}
      </span>
    </li>
  );
}
