import { type KeyboardEvent, useRef, useState } from "react";

export interface PaletteTileProps {
  tabIndex: 0 | -1;
  ref: (element: HTMLElement | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onFocus: () => void;
}

/**
 * One tab stop for the palette's two rows of tiles. ←/→ walk them in reading order, ↑/↓ change
 * row at the nearest column, Home/End go to the first and the last. Arrows only move: a tile adds
 * on Enter or Space, as the button it is.
 */
export function usePaletteKeys(rows: readonly (readonly string[])[]) {
  const [active, setActive] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const order = rows.flat();
  const tabStop = active !== null && order.includes(active) ? active : (order[0] ?? null);

  const move = (event: KeyboardEvent<HTMLElement>, next: string | undefined) => {
    event.preventDefault();
    if (next === undefined) return;
    setActive(next);
    elements.current.get(next)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, id: string) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const at = order.indexOf(id);
    switch (event.key) {
      case "ArrowRight":
        move(event, order[Math.min(order.length - 1, at + 1)]);
        return;
      case "ArrowLeft":
        move(event, order[Math.max(0, at - 1)]);
        return;
      case "ArrowUp":
      case "ArrowDown": {
        const row = rows.findIndex((r) => r.includes(id));
        const target = rows[row + (event.key === "ArrowDown" ? 1 : -1)];
        if (!target || target.length === 0) {
          event.preventDefault();
          return;
        }
        const column = rows[row]!.indexOf(id);
        move(event, target[Math.min(column, target.length - 1)]);
        return;
      }
      case "Home":
        move(event, order[0]);
        return;
      case "End":
        move(event, order[order.length - 1]);
        return;
    }
  };

  const tileProps = (id: string): PaletteTileProps => ({
    tabIndex: id === tabStop ? 0 : -1,
    ref: (element) => {
      if (element) elements.current.set(id, element);
      else elements.current.delete(id);
    },
    onKeyDown: (event) => onKeyDown(event, id),
    onFocus: () => setActive(id),
  });

  return { tileProps };
}
