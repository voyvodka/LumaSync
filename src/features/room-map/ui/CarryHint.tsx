import { useTranslation } from "react-i18next";

import { StateSwap } from "@/shared/ui/StateSwap/StateSwap";

import type { CarryHint as Hint } from "../model/carryHint";
import styles from "./CarryHint.module.css";

/** The keys a carry in the 3D room answers to, under the top bar while a piece that has them is selected. */
export function CarryHint({ hint }: { hint: Hint | null }) {
  const { t } = useTranslation();
  const key = (cap: string, label: string) => (
    <span className={styles.key}>
      <kbd>{cap}</kbd>
      {label}
    </span>
  );
  const letGo = key(t("roomMap:shortcuts.keys.escape"), t("roomMap:carryHint.letGo"));
  return (
    // The same keys are in the shortcuts list; read out on every selection, they would only repeat it.
    <div className={styles.slot} data-testid="carry-hint" data-hint={hint ?? undefined} aria-hidden="true">
      <StateSwap
        fit
        state={hint ?? "none"}
        faces={{
          none: null,
          turn: (
            <span className={styles.line}>
              {key("R", t("roomMap:carryHint.turn"))}
              {letGo}
            </span>
          ),
          rise: (
            <span className={styles.line}>
              {key("Shift", t("roomMap:carryHint.rise"))}
              {letGo}
            </span>
          ),
        }}
      />
    </div>
  );
}
