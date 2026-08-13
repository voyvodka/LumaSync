import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
 * Wave 4-G #5 polish:
 *  - Migrated from the legacy zinc / red-400 palette to the amber
 *    Rev 07 dock tokens (`lm-context-menu*`) so it stops reading as a
 *    different app next to the rest of the editor chrome.
 *  - Two-pass positioning — render hidden (`visibility: hidden`) at
 *    `(x, y)`, measure with `getBoundingClientRect`, then clamp inside
 *    an 8 px viewport safe-zone before flipping `visibility` back on.
 *    This kills the "menu opens far from the cursor" flicker that
 *    came from the menu animating from the raw mouse coords to the
 *    clamped position on the same frame.
 *  - Each action clears the 32 px tap-target floor.
 */
export function ContextMenu({ x, y, actions, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // 8 px breathing room around every viewport edge — large enough to
    // dodge titlebar / status-bar chrome while still letting the menu
    // hug the cursor on small windows. Matches `ls-design-language`'s
    // safe-zone guidance for floating panels.
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

  return (
    <div
      ref={ref}
      role="menu"
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
          aria-label={action.label}
          className={[
            "lm-context-menu-item",
            action.danger ? "is-danger" : "",
            action.disabled ? "is-disabled" : "",
          ]
            .filter(Boolean)
            .join(" ")}
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
