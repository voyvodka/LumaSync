import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { prefersReducedMotion } from "@/shared/lib/motion";
import { cx } from "@/shared/lib/cx";
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
  /**
   * The child is the scroller, reaching over the popover's padding so its scrollbar runs along the
   * border. The popover's own scroll box then stands down: kept, it scrolled the child's reach as a
   * second bar on Windows, where scrollbars take room.
   */
  childScrolls?: boolean;
  children: ReactNode;
}

/** What a popover opened inside another (a list from a field in it) registers with: portalled to the
 *  body, its presses were outside the outer one, and a choice there closed both. */
interface PopoverNest {
  add(node: HTMLElement): () => void;
}
const NestContext = createContext<PopoverNest | null>(null);

/**
 * A small surface next to its anchor, portalled with a fixed position so no
 * scrolling parent clips it. Outside press, Esc or the anchor scrolling away
 * closes it; Esc hands focus back to the anchor. It rises in and settles out:
 * a closed popover stays mounted for its short exit before it goes.
 */
export function Popover({ open, onClose, anchorRef, side = "above", width = 240, id, label, role, childScrolls = false, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const parent = useContext(NestContext);
  const nested = useRef(new Set<HTMLElement>());
  const nest = useMemo<PopoverNest>(
    () => ({
      add(node) {
        nested.current.add(node);
        return () => nested.current.delete(node);
      },
    }),
    [],
  );
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    arrow: number;
    width: number;
    side: "above" | "below";
    /** Set only when the content is taller than the room on either side. */
    maxHeight?: number;
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
    const place = () => {
      const anchor = anchorRef.current;
      const pop = ref.current;
      if (!anchor || !pop) return;
      const a = anchor.getBoundingClientRect();
      // scrollHeight: once a max height clamps it, the box no longer says how tall its content is.
      const h = Math.max(pop.offsetHeight, pop.scrollHeight);
      const w =
        width === "fit" ? Math.min(Math.max(pop.offsetWidth, a.width), window.innerWidth - 16) : width;
      const left = Math.max(8, Math.min(a.left + a.width / 2 - w / 2, window.innerWidth - w - 8));
      // The asked side unless the popover would run off the window there and fits on the other. When
      // it fits on neither — a long list in a short window — it takes the roomier side and scrolls.
      const roomAbove = a.top - 10 - 8;
      // The status bar is the window's floor: a list that ran under it covered the outputs' state.
      const floor = document.querySelector("[data-popover-floor]")?.getBoundingClientRect().top ?? window.innerHeight;
      const roomBelow = Math.min(window.innerHeight, floor) - 8 - (a.bottom + 10);
      const fitsAbove = h <= roomAbove;
      const fitsBelow = h <= roomBelow;
      const placed =
        !fitsAbove && !fitsBelow
          ? roomAbove > roomBelow
            ? "above"
            : "below"
          : side === "below"
            ? !fitsBelow && fitsAbove
              ? "above"
              : "below"
            : !fitsAbove && fitsBelow
              ? "below"
              : "above";
      const room = placed === "above" ? roomAbove : roomBelow;
      const maxHeight = h > room ? Math.max(room, 0) : undefined;
      const shown = maxHeight ?? h;
      const top = placed === "above" ? Math.max(8, a.top - shown - 10) : a.bottom + 10;
      const arrow = a.left + a.width / 2 - left;
      setPos((prev) =>
        prev &&
        prev.left === left &&
        prev.top === top &&
        prev.arrow === arrow &&
        prev.width === w &&
        prev.side === placed &&
        prev.maxHeight === maxHeight
          ? prev
          : { left, top, arrow, width: w, side: placed, maxHeight },
      );
    };
    place();
    // Content that grows after opening (Room settings gaining its shape rows) is placed again, or it
    // runs off the window on the side it was first placed for.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    for (const child of Array.from(ref.current.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [open, anchorRef, side, width]);

  useEffect(() => {
    const node = ref.current;
    if (!open || !parent || !node) return;
    return parent.add(node);
  }, [open, parent]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const inside = ref.current?.contains(target) || anchorRef.current?.contains(target);
      if (!inside && ![...nested.current].some((node) => node.contains(target))) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      // Esc closes the innermost popover only; every one listens on the document.
      if (event.key !== "Escape" || nested.current.size > 0) return;
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
          maxHeight: pos?.maxHeight,
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
      {/* The scroller is inside, so a capped popover keeps its notch: overflow would clip it. */}
      <div className={cx(styles.content, childScrolls && styles.childScrolls)}>
        <NestContext.Provider value={nest}>{children}</NestContext.Provider>
      </div>
    </div>,
    document.body,
  );
}
