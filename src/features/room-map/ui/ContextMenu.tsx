import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cx } from "@/shared/lib/cx";

export interface ContextMenuAction {
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  actions: ContextMenuAction[];
  onClose: () => void;
}

/**
 * Right-click context menu for the room map editor.
 *
 * Notes:
 *  - Two-pass positioning — render hidden (`visibility: hidden`) at
 *    `(x, y)`, measure with `getBoundingClientRect`, then clamp inside
 *    an 8 px viewport safe-zone before flipping `visibility` back on.
 *    This kills the "menu opens far from the cursor" flicker that
 *    came from the menu animating from the raw mouse coords to the
 *    clamped position on the same frame.
 *  - Each action clears the 32 px tap-target floor.
 *  - A WAI-ARIA menu: focus moves to the first item on open, the arrows,
 *    Home and End move between items, Tab or Escape closes, and focus goes
 *    back to where it was when the menu closes.
 */
export function ContextMenu({ x, y, actions, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Enough to clear the titlebar and status-bar chrome without stopping the
    // menu hugging the cursor at compact width.
    const pad = 8;
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - pad) {
      left = window.innerWidth - rect.width - pad;
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = window.innerHeight - rect.height - pad;
    }
    if (left < pad) left = pad;
    if (top < pad) top = pad;
    setPos({ left, top });
  }, [x, y]);

  // Not on mount: the first pass is `visibility: hidden`, and a hidden item
  // cannot take focus.
  const placed = pos !== null;
  useEffect(() => {
    if (placed) ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [placed]);

  useEffect(() => {
    const returnTo = document.activeElement;
    return () => {
      // Only when focus is still ours to give: an action that opened a dialog
      // has already moved it.
      const now = document.activeElement;
      if (returnTo instanceof HTMLElement && returnTo.isConnected && (now === null || now === document.body)) {
        returnTo.focus();
      }
    };
  }, []);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // A Hue channel has no action of its own; right-clicking one drew an empty
  // frame with nothing to focus.
  if (actions.length === 0) return null;

  const handleMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      onClose();
      return;
    }
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'),
    );
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown"
        ? items[(at + 1) % items.length]
        : e.key === "ArrowUp"
          ? items[(at - 1 + items.length) % items.length]
          : e.key === "Home"
            ? items[0]
            : e.key === "End"
              ? items[items.length - 1]
              : undefined;
    if (!next) return;
    e.preventDefault();
    next.focus();
  };

  return (
    <div
      ref={ref}
      role="menu"
      onKeyDown={handleMenuKeyDown}
      className="lm-context-menu"
      style={{
        // First-pass render is invisible at the raw cursor coords so
        // the layout effect can measure without a flash. Second pass
        // (after clamp) flips visibility on at the final coords.
        position: "fixed",
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {actions.map((action, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          tabIndex={-1}
          aria-label={action.label}
          className={cx(
            "lm-context-menu-item",
            action.danger ? "is-danger" : "",
            action.disabled ? "is-disabled" : "",
          )}
          onClick={() => {
            if (action.disabled) return;
            action.onClick();
            onClose();
          }}
          disabled={action.disabled}
        >
          <span className="lm-context-menu-item-label">{action.label}</span>
          {action.shortcut ? (
            <span className="lm-context-menu-item-kbd">{action.shortcut}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
