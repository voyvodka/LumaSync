import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { getPreference, setPreference, usePreference } from "@/features/persistence/preferences";
import type { LightingModeConfig } from "@/shared/contracts/mode";
import { SCENE_LIMITS, type StoredScene } from "@/shared/contracts/scenes";
import { IconButton } from "@/shared/ui/IconButton/IconButton";
import { IconPlus, IconSliders } from "@/shared/ui/icons";
import { Popover } from "@/shared/ui/Popover/Popover";
import { StateSwap } from "@/shared/ui/StateSwap/StateSwap";

import {
  SUGGESTED_SCENE_ORDER,
  isSceneAvailable,
  sceneFromMode,
  sceneMatches,
  sceneName,
  sceneSmoothing,
  sceneSwatch,
  suggestedScene,
  toModeConfig,
  withScene,
  withSceneLook,
  withSceneName,
} from "../model/sceneLibrary";
import { editScenes, getSceneEdit, setSceneEdit, useSceneEdit, useScenes } from "../state/scenesStore";
import { SceneEditBar } from "./SceneEditBar";
import { SceneLibrary } from "./SceneLibrary";
import { ScenesRow } from "./ScenesRow";
import styles from "./ScenesRow.module.css";

interface ScenesProps {
  mode: LightingModeConfig;
  /** No output to light, or a lock: the scenes cannot be played. */
  disabled: boolean;
  /** A choice is in flight: a press waits for it, and nothing dims meanwhile. */
  busy?: boolean;
  onApply: (next: LightingModeConfig) => void;
}

/** Focus after the swap has landed; a control that is gone or disabled hands it to the library button. */
const focusByTestId = (testId: string) =>
  requestAnimationFrame(() => {
    const target = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    const usable = target && !target.matches(":disabled") ? target : null;
    (usable ?? document.querySelector<HTMLElement>('[data-testid="scene-library-open"]'))?.focus({ preventScroll: true });
  });

/**
 * The user's scenes under the mode strip, with making a new one and the library beside them. A scene
 * is made or edited with the page's own controls: the row gives way, in place, to a bar naming it,
 * the light previews every change, and Save writes it while Cancel puts the light back as it was.
 */
export function Scenes({ mode, disabled, busy = false, onApply }: ScenesProps) {
  const { t } = useTranslation();
  const scenes = useScenes();
  const smoothing = usePreference("lightingIntensityPreset");
  const edit = useSceneEdit();
  const [libraryOpen, setLibraryOpen] = useState(false);
  // Keyed, so the same words said twice are announced twice.
  const [announce, setAnnounce] = useState({ text: "", key: 0 });
  const [saveFailed, setSaveFailed] = useState(false);
  const say = (text: string) => setAnnounce(({ key }) => ({ text, key: key + 1 }));
  const libraryRef = useRef<HTMLButtonElement | null>(null);
  const libraryId = useId();

  const activeId = scenes.find((scene) => sceneMatches(scene, mode, smoothing))?.id;
  const look = sceneFromMode(mode, smoothing);
  const full = scenes.length >= SCENE_LIMITS.maxScenes;
  const editedScene = edit?.sceneId ? scenes.find((scene) => scene.id === edit.sceneId) : undefined;
  // The scene went while it was open — deleted from another window: nothing is left to write into.
  const orphaned = Boolean(edit?.sceneId && !editedScene);
  useEffect(() => {
    if (orphaned) setSceneEdit(null);
  }, [orphaned]);

  /** Plays a scene: Rust reads Ambilight's smoothing from the preference, so that lands first. */
  const play = async (scene: StoredScene) => {
    const config = toModeConfig(scene);
    if (!config) return;
    const preset = sceneSmoothing(scene);
    if (preset && preset !== smoothing) await setPreference("lightingIntensityPreset", preset);
    onApply(config);
  };

  const pick = (id: string) => {
    const scene = scenes.find((s) => s.id === id);
    if (busy || !scene) return;
    void play(scene).catch((error: unknown) => console.error("[LumaSync] applying the scene failed:", error));
  };

  const openEdit = (sceneId: string | null) => {
    if (busy || disabled || edit) return;
    const scene = sceneId ? scenes.find((s) => s.id === sceneId) : undefined;
    if (sceneId && (!scene || !isSceneAvailable(scene))) return;
    setSaveFailed(false);
    setSceneEdit({ sceneId, name: scene?.name ?? "", before: { mode, smoothing } });
    focusByTestId("scene-edit-name");
    if (scene && scene.id !== activeId) {
      void play(scene).catch((error: unknown) => console.error("[LumaSync] applying the scene failed:", error));
    }
  };

  const closeEdit = (focusTestId: string) => {
    setSceneEdit(null);
    focusByTestId(focusTestId);
  };

  // The look as it would be saved, keeping a library scene's name until the user gives it another.
  const draft: StoredScene | null = look ? { id: "draft", ...look, suggestedId: editedScene?.suggestedId } : null;

  const save = () => {
    if (!edit || !look || (edit.sceneId === null && full)) return;
    const { sceneId, name } = edit;
    // Minted outside the edit: it runs twice, on this window's list and on the stored one.
    const id = sceneId ?? crypto.randomUUID();
    const written = (list: readonly StoredScene[]) =>
      withSceneName(sceneId ? withSceneLook(list, id, look) : withScene(list, { id, ...look }), id, name);
    const shownName = name.trim() || (draft ? sceneName(draft, t) : "");
    setSaveFailed(false);
    editScenes(written).then(
      () => say(t("lights:scenes.savedNamed", { name: shownName })),
      (error: unknown) => {
        console.error("[LumaSync] saving the scene failed:", error);
        say(t("lights:scenes.saveFailed"));
        // Another edit opened while this one was being written: it is not taken over.
        if (getSceneEdit() !== null) return;
        // The list went back; the edit comes back with it, so nothing typed or set is lost.
        setSceneEdit(edit);
        setSaveFailed(true);
        focusByTestId("scene-edit-save");
      },
    );
    closeEdit(`scene-${id}`);
  };

  const cancel = () => {
    if (!edit || busy) return;
    const { before, sceneId } = edit;
    closeEdit(sceneId ? `scene-${sceneId}` : "scene-save");
    // Turned off meanwhile — the power switch, the tray, ⌥1: Cancel does not turn the lights back on.
    if (mode.kind === "off") return;
    const moved = JSON.stringify(before.mode) !== JSON.stringify(mode) || before.smoothing !== smoothing;
    if (!moved) return;
    void (async () => {
      if (before.smoothing !== smoothing) {
        await setPreference("lightingIntensityPreset", before.smoothing);
        // A write that failed puts the preference back where the edit left it: say so, since the
        // light comes back without its response.
        if (getPreference("lightingIntensityPreset") !== before.smoothing) say(t("lights:scenes.restoreFailed"));
      }
      onApply(before.mode);
    })().catch((error: unknown) => console.error("[LumaSync] putting the light back failed:", error));
  };

  const editing = edit !== null && !orphaned;
  // Where Reset goes: a library scene's own look, else the scene as saved. A new scene has none.
  const suggestedId = editedScene?.suggestedId;
  const resetTo =
    editedScene && suggestedId && SUGGESTED_SCENE_ORDER.includes(suggestedId)
      ? suggestedScene(suggestedId, editedScene.id)
      : editedScene;
  const reset = () => {
    if (!resetTo || busy) return;
    void play(resetTo).catch((error: unknown) => console.error("[LumaSync] resetting the scene failed:", error));
  };

  return (
    <div className={styles.slot}>
      <StateSwap
        state={editing ? "edit" : "row"}
        faces={{
          row: (
            <ScenesRow
              disabled={disabled}
              scenes={scenes.map((scene) => ({
                id: scene.id,
                name: sceneName(scene, t),
                swatch: sceneSwatch(scene),
                active: scene.id === activeId,
                unavailable: !isSceneAvailable(scene),
              }))}
              onPick={pick}
              placeholder={
                <button
                  type="button"
                  className={`${styles.chip} ${styles.ghost}`}
                  disabled={!look || disabled}
                  onClick={() => openEdit(null)}
                  data-testid="scene-save-first"
                >
                  {t("lights:scenes.saveFirst")}
                </button>
              }
              trailing={
                <>
                  <IconButton
                    className={styles.action}
                    label={t("lights:scenes.save")}
                    title={full ? t("lights:scenes.full", { max: SCENE_LIMITS.maxScenes }) : t("lights:scenes.save")}
                    icon={<IconPlus />}
                    disabled={!look || full || disabled}
                    onClick={() => openEdit(null)}
                    data-testid="scene-save"
                  />
                  <IconButton
                    ref={libraryRef}
                    className={styles.action}
                    label={t("lights:scenes.manage")}
                    icon={<IconSliders />}
                    aria-expanded={libraryOpen}
                    aria-controls={libraryOpen ? libraryId : undefined}
                    aria-haspopup="dialog"
                    data-open={libraryOpen || undefined}
                    onClick={() => setLibraryOpen((open) => !open)}
                    data-testid="scene-library-open"
                  />
                </>
              }
            />
          ),
          edit: (
            <SceneEditBar
              label={
                editedScene
                  ? t("lights:scenes.editing", { name: sceneName(editedScene, t) })
                  : t("lights:scenes.save")
              }
              name={edit?.name ?? ""}
              placeholder={draft ? sceneName(draft, t) : editedScene ? sceneName(editedScene, t) : ""}
              swatch={draft ? sceneSwatch(draft) : "var(--lm-panel-2)"}
              canSave={Boolean(look)}
              failed={saveFailed}
              reset={
                resetTo
                  ? {
                      label: t(resetTo === editedScene ? "lights:scenes.resetSaved" : "lights:scenes.resetSuggested"),
                      done: sceneMatches(resetTo, mode, smoothing),
                      onReset: reset,
                    }
                  : undefined
              }
              onName={(name) => edit && setSceneEdit({ ...edit, name })}
              onSave={save}
              onCancel={cancel}
            />
          ),
        }}
      />
      <span key={announce.key} className="sr-only" aria-live="polite">
        {announce.text}
      </span>
      <Popover
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        anchorRef={libraryRef}
        side="below"
        width={256}
        id={libraryId}
        label={t("lights:scenes.manage")}
        role="dialog"
      >
        <SceneLibrary
          scenes={scenes}
          anchorRef={libraryRef}
          onClose={() => setLibraryOpen(false)}
          onEdit={(id) => {
            setLibraryOpen(false);
            openEdit(id);
          }}
        />
      </Popover>
    </div>
  );
}
