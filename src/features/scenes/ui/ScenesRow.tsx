import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import styles from "./ScenesRow.module.css";

export interface SceneChip {
  id: string;
  name: string;
  /** A CSS background: the scene's own light. */
  swatch: string;
  active: boolean;
  /** A scene this build cannot play (saved by a newer one). */
  unavailable?: boolean;
}

interface ScenesRowProps {
  scenes: readonly SceneChip[];
  disabled?: boolean;
  onPick: (id: string) => void;
  /** Controls at the row's end: save, the library. */
  trailing?: ReactNode;
  /** The compact window: one line that scrolls sideways instead of wrapping. */
  dense?: boolean;
}

/** The user's scenes as a row of chips under the mode strip; one press is the whole look. */
export function ScenesRow({ scenes, disabled = false, onPick, trailing, dense = false }: ScenesRowProps) {
  const { t } = useTranslation();
  // A pick lands with a small scale-in; the one already chosen when the page opens does not.
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className={styles.row} data-dense={dense || undefined}>
      <div
        className={styles.list}
        role="radiogroup"
        aria-label={t("lights:scenes.title")}
        data-placed={placed || undefined}
      >
        {scenes.map((scene) => (
          <button
            key={scene.id}
            type="button"
            role="radio"
            aria-checked={scene.active}
            className={styles.chip}
            disabled={disabled || scene.unavailable}
            title={scene.unavailable ? t("lights:scenes.unavailable") : scene.name}
            onClick={() => onPick(scene.id)}
            data-testid={`scene-${scene.id}`}
          >
            <span className={styles.swatch} style={{ background: scene.swatch }} aria-hidden />
            <span className={styles.name}>{scene.name}</span>
          </button>
        ))}
      </div>
      {trailing ? <div className={styles.trailing}>{trailing}</div> : null}
    </div>
  );
}
