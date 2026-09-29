import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { SCENE_LIMITS, type StoredScene, type SuggestedSceneId } from "@/shared/contracts/scenes";
import { IconButton } from "@/shared/ui/IconButton/IconButton";
import { IconChevronDown, IconChevronUp, IconPencil, IconPlus, IconTrash } from "@/shared/ui/icons";
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

/**
 * The library popover: the user's scenes to rename, reorder and delete, then the suggested ones not
 * yet in the list to add. A row's actions show on hover or focus; nothing moves when they do.
 */
export function SceneLibrary({ scenes }: { scenes: readonly StoredScene[] }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const inList = new Set(scenes.map((scene) => scene.suggestedId).filter(Boolean));
  const suggestions = SUGGESTED_SCENE_ORDER.filter((id) => !inList.has(id));
  const full = scenes.length >= SCENE_LIMITS.maxScenes;

  const edit = (change: (list: readonly StoredScene[]) => StoredScene[]) => {
    setFailed(false);
    void editScenes(change).catch(() => setFailed(true));
  };
  const add = (suggestedId: SuggestedSceneId) => {
    const scene = suggestedScene(suggestedId, crypto.randomUUID());
    edit((list) => withScene(list, scene));
  };

  return (
    <div className={styles.library}>
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
              onRename={(name) => edit((list) => withSceneName(list, scene.id, name))}
              onMove={(delta) => edit((list) => withSceneMoved(list, scene.id, delta))}
              onRemove={() => edit((list) => withoutScene(list, scene.id))}
            />
          ))}
        </ul>
      )}
      {suggestions.length > 0 ? (
        <>
          <h3 className={styles.heading}>{t("lights:scenes.suggestedTitle")}</h3>
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
                    title={full ? t("lights:scenes.full", { max: SCENE_LIMITS.maxScenes }) : undefined}
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
    if (byKey) requestAnimationFrame(() => renameRef.current?.focus());
    if (keep && draft.trim() !== (scene.name ?? "")) onRename(draft);
  };

  return (
    <li className={styles.row} data-unavailable={!isSceneAvailable(scene) || undefined} data-testid={`scene-entry-${scene.id}`}>
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
        <span className={styles.name} title={isSceneAvailable(scene) ? undefined : t("lights:scenes.unavailable")}>
          {name}
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
        <IconButton
          className={styles.action}
          label={t("lights:scenes.moveUp", { name })}
          icon={<IconChevronUp />}
          disabled={first}
          onClick={() => onMove(-1)}
          data-testid={`scene-up-${scene.id}`}
        />
        <IconButton
          className={styles.action}
          label={t("lights:scenes.moveDown", { name })}
          icon={<IconChevronDown />}
          disabled={last}
          onClick={() => onMove(1)}
          data-testid={`scene-down-${scene.id}`}
        />
        <IconButton
          className={styles.action}
          label={armed ? t("lights:scenes.removeConfirm", { name }) : t("lights:scenes.remove", { name })}
          icon={<IconTrash />}
          data-danger={armed || undefined}
          onClick={() => (armed ? onRemove() : setArmed(true))}
          onBlur={() => setArmed(false)}
          data-testid={`scene-remove-${scene.id}`}
        />
      </span>
    </li>
  );
}
