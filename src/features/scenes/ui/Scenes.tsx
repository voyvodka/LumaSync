import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { setPreference, usePreference } from "@/features/persistence/preferences";
import type { LightingModeConfig } from "@/shared/contracts/mode";
import { SCENE_LIMITS } from "@/shared/contracts/scenes";
import { IconButton } from "@/shared/ui/IconButton/IconButton";
import { IconPlus, IconSliders } from "@/shared/ui/icons";
import { Popover } from "@/shared/ui/Popover/Popover";

import {
  isSceneAvailable,
  sceneFromMode,
  sceneMatches,
  sceneName,
  sceneSmoothing,
  sceneSwatch,
  toModeConfig,
  withScene,
} from "../model/sceneLibrary";
import { editScenes, useScenes } from "../state/scenesStore";
import { SceneLibrary } from "./SceneLibrary";
import { ScenesRow } from "./ScenesRow";
import styles from "./ScenesRow.module.css";

interface ScenesProps {
  mode: LightingModeConfig;
  /** No output to light, a lock, or a choice in flight: the scenes cannot be played. */
  disabled: boolean;
  onApply: (next: LightingModeConfig) => void;
  dense?: boolean;
}

/** The user's scenes under the mode strip, with saving the running light and the library beside them. */
export function Scenes({ mode, disabled, onApply, dense = false }: ScenesProps) {
  const { t } = useTranslation();
  const scenes = useScenes();
  const smoothing = usePreference("lightingIntensityPreset");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const libraryRef = useRef<HTMLButtonElement | null>(null);
  const libraryId = useId();

  const activeId = scenes.find((scene) => sceneMatches(scene, mode, smoothing))?.id;
  const look = sceneFromMode(mode, smoothing);
  const full = scenes.length >= SCENE_LIMITS.maxScenes;
  const saveTitle = full
    ? t("lights:scenes.full", { max: SCENE_LIMITS.maxScenes })
    : activeId
      ? t("lights:scenes.saved")
      : t("lights:scenes.save");

  const pick = async (id: string) => {
    const scene = scenes.find((s) => s.id === id);
    const config = scene ? toModeConfig(scene) : null;
    if (!scene || !config) return;
    // Rust reads Ambilight's smoothing from the preference when it builds the payload, so it lands first.
    const preset = sceneSmoothing(scene);
    if (preset && preset !== smoothing) await setPreference("lightingIntensityPreset", preset);
    onApply(config);
  };

  const save = () => {
    if (!look) return;
    // Outside the edit: it runs twice, on this window's list and on the stored one.
    const scene = { id: crypto.randomUUID(), ...look };
    void editScenes((list) => withScene(list, scene)).catch((error: unknown) => {
      console.error("[LumaSync] saving the scene failed:", error);
    });
  };

  return (
    <ScenesRow
      dense={dense}
      disabled={disabled}
      scenes={scenes.map((scene) => ({
        id: scene.id,
        name: sceneName(scene, t),
        swatch: sceneSwatch(scene),
        active: scene.id === activeId,
        unavailable: !isSceneAvailable(scene),
      }))}
      onPick={(id) =>
        void pick(id).catch((error: unknown) => console.error("[LumaSync] applying the scene failed:", error))
      }
      placeholder={
        <button
          type="button"
          className={`${styles.chip} ${styles.ghost}`}
          disabled={!look}
          onClick={save}
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
            title={saveTitle}
            icon={<IconPlus />}
            disabled={!look || Boolean(activeId) || full}
            onClick={save}
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
          <Popover
            open={libraryOpen}
            onClose={() => setLibraryOpen(false)}
            anchorRef={libraryRef}
            side="below"
            width={300}
            id={libraryId}
            label={t("lights:scenes.manage")}
            role="dialog"
          >
            <SceneLibrary scenes={scenes} anchorRef={libraryRef} onClose={() => setLibraryOpen(false)} />
          </Popover>
        </>
      }
    />
  );
}
