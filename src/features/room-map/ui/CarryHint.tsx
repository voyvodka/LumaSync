import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { StateSwap } from "@/shared/ui/StateSwap/StateSwap";

import type { CarryHint as Hint } from "../model/carryHint";
import styles from "./CarryHint.module.css";
import { DOCK_BOTTOM_PX, DOCK_HEIGHT_PX } from "./dock/dockGeometry";
import { IS_MAC } from "./keyCaps";

// Over the dock, by the card the keys act on, rather than under the top bar across the room.
const SLOT = { "--carry-hint-bottom": `${DOCK_BOTTOM_PX + DOCK_HEIGHT_PX + 10}px` } as CSSProperties;

/** `free`: the carried piece snaps to what it lines up with, and ⌥ lets it move without. */
export function CarryHint({ hint, free = false }: { hint: Hint | null; free?: boolean }) {
  const { t } = useTranslation();
  const key = (cap: string, label: string) => (
    <span className={styles.key}>
      <kbd>{cap}</kbd>
      {label}
    </span>
  );
  const letGo = (
    <>
      {free ? key(IS_MAC ? "⌥" : "Alt", t("roomMap:carryHint.free")) : null}
      {key(t("roomMap:shortcuts.keys.escape"), t("roomMap:carryHint.letGo"))}
    </>
  );
  return (
    // aria-hidden: the shortcuts list names the same keys.
    <div className={styles.slot} style={SLOT} data-testid="carry-hint" data-hint={hint ?? undefined} aria-hidden="true">
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
          draw: (
            <span className={styles.line}>
              <span>{t("roomMap:carryHint.draw")}</span>
              {key(t("roomMap:shortcuts.keys.escape"), t("roomMap:carryHint.cancel"))}
            </span>
          ),
        }}
      />
    </div>
  );
}
