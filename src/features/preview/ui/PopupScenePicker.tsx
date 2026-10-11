import { useTranslation } from "react-i18next";

import type { TranslationKey } from "@/features/i18n/catalogue";
import { SCENE_KINDS, type SceneKind } from "@/shared/contracts/preview";

import styles from "./PopupScenePicker.module.css";

// Literal keys, not a template: the orphan ratchet reads source text.
const SCENE_NAMES = {
  edgeTour: "preview:scenes.names.edgeTour",
  spiral: "preview:scenes.names.spiral",
  sunset: "preview:scenes.names.sunset",
  colorFields: "preview:scenes.names.colorFields",
  letterbox: "preview:scenes.names.letterbox",
} as const satisfies Record<SceneKind, TranslationKey>;

interface PopupScenePickerProps {
  /** The scene that plays, `null` with none. */
  playing: SceneKind | null;
  /** A start or stop is in flight: a press is ignored until it lands, but nothing dims. */
  busy: boolean;
  onPick: (kind: SceneKind) => void;
}

/** The test scenes, first in the popup. A press plays one; the playing one's press stops it. */
export function PopupScenePicker({ playing, busy, onPick }: PopupScenePickerProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.grid} role="group" aria-label={t("preview:scenes.label")}>
      {SCENE_KINDS.map((kind) => {
        const name = t(SCENE_NAMES[kind]);
        const isPlaying = playing === kind;
        return (
          <button
            key={kind}
            type="button"
            className={styles.tile}
            aria-pressed={isPlaying}
            title={isPlaying ? t("preview:scenes.stop", { name }) : undefined}
            onClick={() => {
              if (!busy) onPick(kind);
            }}
            data-testid={`popup-scene-${kind}`}
          >
            <span className={styles.swatch} data-scene={kind} aria-hidden="true" />
            <span className={styles.name}>{name}</span>
          </button>
        );
      })}
    </div>
  );
}
