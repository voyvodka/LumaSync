import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useFlip } from "@/shared/lib/useFlip";

import styles from "./ScenesRow.module.css";
import { useArrivals } from "./useArrivals";

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
  /** Shown in the list's place while it is empty. */
  placeholder?: ReactNode;
}

/** The user's scenes as a row of chips under the mode strip; one press is the whole look. */
export function ScenesRow({ scenes, disabled = false, onPick, trailing, dense = false, placeholder }: ScenesRowProps) {
  const { t } = useTranslation();
  // A pick lands with a small scale-in; the one already chosen when the page opens does not.
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  // A chip just saved or added grows in.
  const { arrived, settled } = useArrivals(scenes.map((scene) => scene.id));
  // Reordered in the library behind the popover: the chips slide to their new places.
  const listRef = useRef<HTMLDivElement | null>(null);
  useFlip(listRef, scenes.map((scene) => scene.id));
  return (
    <div className={styles.row} data-dense={dense || undefined}>
      {scenes.length === 0 && placeholder ? (
        <div className={styles.list}>{placeholder}</div>
      ) : (
        <div
          ref={listRef}
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
              data-arrived={arrived.has(scene.id) || undefined}
              data-flip-id={scene.id}
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget) settled(scene.id);
              }}
              data-testid={`scene-${scene.id}`}
            >
              <span className={styles.swatch} style={{ background: scene.swatch }} aria-hidden />
              <span className={styles.name}>{scene.name}</span>
            </button>
          ))}
        </div>
      )}
      {trailing ? <div className={styles.trailing}>{trailing}</div> : null}
    </div>
  );
}
