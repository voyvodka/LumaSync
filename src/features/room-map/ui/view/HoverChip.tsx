import type { Ref } from "react";
import { useTranslation } from "react-i18next";

import styles from "./HoverChip.module.css";

/** aria-hidden: the dock lists the same lights with their state. Without `level`, the name alone. */
export function HoverChip({ name, lit, level, chipRef }: { name: string; lit: boolean; level?: number; chipRef: Ref<HTMLDivElement> }) {
  const { t } = useTranslation();
  return (
    <div ref={chipRef} className={styles.chip} data-lit={lit ? "" : undefined} aria-hidden="true">
      <span className={styles.dot} />
      <span>{name}</span>
      {level !== undefined && (
        <span className={styles.state}>
          {lit ? t("roomMap:view.hover.on", { percent: Math.round(level * 100) }) : t("roomMap:view.hover.off")}
        </span>
      )}
    </div>
  );
}
