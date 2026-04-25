import { useEffect, useRef, useState, useLayoutEffect } from "react";

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

export function ContextMenu({ x, y, actions, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp position so menu stays within viewport
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 4;
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
      className="fixed z-[100] min-w-[140px] rounded-md border border-zinc-700 bg-zinc-900 shadow-lg py-1"
      style={{ left: pos.left, top: pos.top }}
    >
      {actions.map((action, i) => (
        <button
          key={i}
          className={[
            "w-full text-left px-3 py-1.5 text-[11px] flex items-center justify-between gap-4",
            action.disabled
              ? "text-zinc-600 cursor-not-allowed"
              : action.danger
                ? "text-red-400 hover:bg-red-900/20"
                : "text-zinc-300 hover:bg-zinc-800",
            "focus-visible:outline-none focus-visible:bg-zinc-800",
          ].join(" ")}
          onClick={() => {
            if (action.disabled) return;
            action.onClick();
            onClose();
          }}
          disabled={action.disabled}
        >
          <span>{action.label}</span>
          {action.shortcut && (
            <span className="text-[9px] text-zinc-500">{action.shortcut}</span>
          )}
        </button>
      ))}
    </div>
  );
}
