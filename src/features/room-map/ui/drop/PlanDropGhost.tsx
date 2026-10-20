import { type Ref, useImperativeHandle, useRef, useState } from "react";

import { furnitureColours } from "@/features/room-view/model/furnitureModel";

import type { LibraryCard } from "../../model/libraryDrop";
import { furnitureTile } from "../../model/paletteTiles";
import { TYPE_DOT_COLOR } from "../../model/zoneColor";
import { FurnitureGlyph } from "../objects/FurnitureGlyph";
import styles from "./PlanDropGhost.module.css";

export interface PlanGhost {
  card: LibraryCard;
  /** Pixels from the stage's top-left. */
  left: number;
  top: number;
  width: number;
  height: number;
  valid: boolean;
}

export interface PlanDropGhostHandle {
  show(ghost: PlanGhost | null): void;
}

const sameCard = (a: LibraryCard | null, b: LibraryCard) => a !== null && a.kind === b.kind && (a.kind === "tv" || (b.kind === "furniture" && a.type === b.type));

/** Moves by style alone: a render per pointer move is what the plan's own drags avoid. */
export function PlanDropGhost({ ref }: { ref: Ref<PlanDropGhostHandle> }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [card, setCard] = useState<LibraryCard | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      show(ghost) {
        const el = box.current;
        if (!ghost) {
          setCard(null);
          return;
        }
        setCard((was) => (sameCard(was, ghost.card) ? was : ghost.card));
        if (!el) return;
        el.style.transform = `translate(${ghost.left}px, ${ghost.top}px)`;
        el.style.width = `${ghost.width}px`;
        el.style.height = `${ghost.height}px`;
        el.toggleAttribute("data-refused", !ghost.valid);
      },
    }),
    [],
  );
  const tile = card?.kind === "furniture" ? furnitureTile(card.type) : null;
  return (
    <div ref={box} className={styles.ghost} hidden={card === null} aria-hidden="true" data-testid="plan-drop-ghost">
      {tile ? (
        <FurnitureGlyph model={tile.model} colours={furnitureColours(tile.piece, tile.model)} width={tile.piece.width} depth={tile.piece.height} fit />
      ) : (
        card && <span className={styles.screen} style={{ background: TYPE_DOT_COLOR.tv }} />
      )}
    </div>
  );
}
