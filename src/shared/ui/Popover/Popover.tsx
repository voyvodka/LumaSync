import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { prefersReducedMotion } from "@/shared/lib/motion";
import { cx } from "../cx";
import styles from "./Popover.module.css";

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  /** Opens above the anchor (the dock sits at the bottom) or below it, when it fits there. */
  side?: "above" | "below";
  /** A fixed width, or `"fit"`: as wide as its content, never narrower than the anchor. */
  width?: number | "fit";
  id?: string;
  label?: string;
  role?: "dialog" | "listbox";
  children: ReactNode;
}

/**
 * A small surface next to its anchor, portalled with a fixed position so no
 * scrolling parent clips it. Outside press, Esc or the anchor scrolling away
 * closes it; Esc hands focus back to the anchor. It rises in and settles out:
 * a closed popover stays mounted for its short exit before it goes.
 */
export function Popover({ open, onClose, anchorRef, side = "above", width = 240, id, label, role, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    arrow: number;
    width: number;
    side: "above" | "below";
  } | null>(null);
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  // Render-time follow of `open`: no frame where a closed popover is still shown as open.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setMounted(true);
      setClosing(false);
      // Unplaced until measured, so a "fit" popover sizes to this opening's content.
      setPos(null);
    } else if (mounted) {
      // No animation runs under reduced motion, so no animationend would ever unmount it.
      if (prefersReducedMotion()) setMounted(false);
      else setClosing(true);
    }
  }

  // The exit normally ends on animationend; this catches one that never fires (hidden, no CSS).
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [closing]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !ref.current) return;
    const a = anchorRef.current.getBoundingClientRect();
    const h = ref.current.offsetHeight;
    const w =
      width === "fit" ? Math.min(Math.max(ref.current.offsetWidth, a.width), window.innerWidth - 16) : width;
    const left = Math.max(8, Math.min(a.left + a.width / 2 - w / 2, window.innerWidth - w - 8));
    // The asked side unless the popover would run off the window there and fits on the other.
    const fitsAbove = a.top - h - 10 >= 8;
    const fitsBelow = a.bottom + 10 + h <= window.innerHeight - 8;
    const placed = side === "below" ? (!fitsBelow && fitsAbove ? "above" : "below") : !fitsAbove && fitsBelow ? "below" : "above";
    const top = placed === "above" ? Math.max(8, a.top - h - 10) : a.bottom + 10;
    setPos({ left, top, arrow: a.left + a.width / 2 - left, width: w, side: placed });
  }, [open, anchorRef, side, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchorRef.current?.contains(target)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
      anchorRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!mounted) return null;
  return createPortal(
    <div
      ref={ref}
      id={id}
      role={role}
      aria-modal={role === "dialog" ? false : undefined}
      aria-label={label}
      aria-hidden={closing || undefined}
      // The notch points at the anchor and the popover grows out of it (and settles back into it).
      style={
        {
          width: pos?.width ?? (width === "fit" ? "max-content" : width),
          left: pos?.left ?? -9999,
          top: pos?.top ?? -9999,
          "--arrow-x": `${pos?.arrow ?? 0}px`,
        } as CSSProperties
      }
      className={cx(styles.pop, styles[pos?.side ?? side], closing && styles.closing)}
      onAnimationEnd={(event) => {
        if (closing && event.target === event.currentTarget) {
          setMounted(false);
          setClosing(false);
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
