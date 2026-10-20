import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useArrivals } from "@/shared/lib/useArrivals";
import { useFlip } from "@/shared/lib/useFlip";
import { useRadioGroup } from "@/shared/lib/useRadioGroup";
import { useSideScroll } from "@/shared/lib/useSideScroll";

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
  /** Shown in the list's place while it is empty. */
  placeholder?: ReactNode;
}

/** The user's scenes as a row of chips under the mode strip; one press is the whole look. */
export function ScenesRow({ scenes, disabled = false, onPick, trailing, placeholder }: ScenesRowProps) {
  const { t } = useTranslation();
  // A pick lands with a small scale-in; the one already chosen when the page opens does not.
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const ids = scenes.map((scene) => scene.id);
  // A chip just saved or added grows in.
  const { arrived, settled } = useArrivals(ids);
  // Reordered in the library behind the popover: the chips slide to their new places.
  const listRef = useRef<HTMLDivElement | null>(null);
  useFlip(listRef, ids);
  const activeId = scenes.find((scene) => scene.active)?.id;
  // One tab stop and the arrow keys, as the mode strip above: six chips were six tab stops.
  const { itemProps } = useRadioGroup({
    values: ids,
    value: activeId ?? null,
    onChange: onPick,
    isDisabled: (id) => disabled || scenes.find((scene) => scene.id === id)?.unavailable === true,
  });
  // Names too: a renamed chip changes width, and the edges' fades are measured afresh.
  const more = useSideScroll(
    listRef,
    scenes.map((scene) => `${scene.id}:${scene.name}`).join("\n"),
    activeId ? `[data-flip-id="${activeId}"]` : undefined,
  );
  return (
    <div className={styles.row}>
      {scenes.length === 0 && placeholder ? (
        <div className={styles.list}>{placeholder}</div>
      ) : (
        <div
          ref={listRef}
          className={styles.list}
          role="radiogroup"
          aria-label={t("lights:scenes.title")}
          data-placed={placed || undefined}
          data-more={more}
        >
          {scenes.map((scene) => (
            <button
              key={scene.id}
              type="button"
              {...itemProps(scene.id)}
              aria-checked={scene.active}
              className={styles.chip}
              disabled={disabled || scene.unavailable}
              title={scene.unavailable ? t("lights:scenes.unavailable") : scene.name}
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
