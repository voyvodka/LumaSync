import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { HsvColorPicker } from "@/shared/ui/HsvColorPicker";
import { EyedropperIcon } from "./EyedropperIcon";
import { HERO_LIGHT_TILE_THRESHOLD, perceivedLuminance, rgbToHex } from "./colorMath";

interface HeroColorCardProps {
  rgb: { r: number; g: number; b: number };
  disabled: boolean;
  sublabel: string;
  onChange: (hex: string) => void;
}

/** Popover sizing constants used to clamp the position into the viewport.
 *  Width matches the rendered HsvColorPicker(compact) + 12 px wrapper padding.
 *  The height is now dynamically measured (see `useLayoutEffect` below) so
 *  that variable-height surfaces — recent-colors strip in particular —
 *  position correctly. The fallback estimate is only used during the very
 *  first render before the popover commits to the DOM. */
const POPOVER_WIDTH_PX = 200;
const POPOVER_FALLBACK_HEIGHT_PX = 270;
const POPOVER_VIEWPORT_MARGIN_PX = 8;

export function HeroColorCard({ rgb, disabled, sublabel, onChange }: HeroColorCardProps) {
  const { t } = useTranslation();
  const hex = rgbToHex(rgb);
  const isLight = perceivedLuminance(rgb) > HERO_LIGHT_TILE_THRESHOLD;
  const textColor = isLight ? "rgba(0,0,0,0.82)" : "rgba(255,255,255,0.92)";
  const subTextColor = isLight ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.65)";
  const edgeColor = isLight ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.18)";
  const eyeBg = isLight ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.28)";

  // Portalled and positioned from a measured height, both load-bearing at
  // 320×480 — see docs/architecture/ui-and-shell.md.
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [popoverPos, setPopoverPos] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);

  const recomputePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    // Prefer the live measurement of the rendered popover; fall back to the
    // estimate only on the very first pass before the DOM has the node.
    const measuredHeight = popoverRef.current?.offsetHeight;
    const desiredHeight = measuredHeight && measuredHeight > 0
      ? measuredHeight
      : POPOVER_FALLBACK_HEIGHT_PX;

    // Available space below the trigger and above it, both already
    // accounting for the 8 px viewport margin.
    const spaceBelow =
      window.innerHeight - rect.bottom - POPOVER_VIEWPORT_MARGIN_PX - 6;
    const spaceAbove = rect.top - POPOVER_VIEWPORT_MARGIN_PX - 6;
    // Pick the side with more room. If neither side fits the popover in
    // full, the larger side hosts the popover with internal scroll.
    const placeAbove = spaceAbove > spaceBelow && desiredHeight > spaceBelow;
    const availableSpace = placeAbove ? spaceAbove : spaceBelow;
    // The popover is allowed to consume the entire available side, capped
    // by the viewport. The CSS rule `overflow-y: auto` inside the popover
    // wrapper does the actual scrolling once the picker exceeds maxHeight.
    const viewportCap =
      window.innerHeight - POPOVER_VIEWPORT_MARGIN_PX * 2;
    const maxHeight = Math.max(120, Math.min(availableSpace, viewportCap));
    const renderHeight = Math.min(desiredHeight, maxHeight);

    const top = placeAbove
      ? Math.max(POPOVER_VIEWPORT_MARGIN_PX, rect.top - renderHeight - 6)
      : Math.min(
          rect.bottom + 6,
          window.innerHeight - renderHeight - POPOVER_VIEWPORT_MARGIN_PX,
        );
    let left = rect.left + rect.width / 2 - POPOVER_WIDTH_PX / 2;
    // Centre-anchoring rarely overflows at 320 px, but resizing the window while
    // the popover is open pushes it flush against the right edge without this.
    const maxLeft = window.innerWidth - POPOVER_WIDTH_PX - POPOVER_VIEWPORT_MARGIN_PX;
    if (left < POPOVER_VIEWPORT_MARGIN_PX) left = POPOVER_VIEWPORT_MARGIN_PX;
    if (left > maxLeft) left = Math.max(POPOVER_VIEWPORT_MARGIN_PX, maxLeft);
    setPopoverPos({ left, top, maxHeight });
  }, []);

  useEffect(() => {
    if (!open) {
      setPopoverPos(null);
      return;
    }
    recomputePosition();
    const onResize = () => recomputePosition();
    const onScroll = () => recomputePosition();
    window.addEventListener("resize", onResize);
    // Capture-phase scroll listener catches scrolls inside compact-body
    // (which is the actual scroller — the window itself does not scroll).
    window.addEventListener("scroll", onScroll, true);
    const onDoc = (e: MouseEvent) => {
      if (popoverRef.current?.contains(e.target as Node)) return;
      if (triggerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, recomputePosition]);

  // Second pass of the two-pass positioning — the fallback estimate is only
  // ever what the first, invisible render uses.
  useLayoutEffect(() => {
    if (!open) return;
    recomputePosition();
    const node = popoverRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => recomputePosition());
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, recomputePosition]);

  const popover = open && popoverPos ? (
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="false"
      aria-label={t("common:mode.solidColor")}
      className="lm-compact-color-popover"
      style={{
        position: "fixed",
        left: popoverPos.left,
        top: popoverPos.top,
        width: POPOVER_WIDTH_PX,
        maxHeight: popoverPos.maxHeight,
        zIndex: 1000,
      }}
    >
      <HsvColorPicker
        value={hex}
        onChange={onChange}
        disabled={disabled}
        ariaLabel={t("common:mode.solidColor")}
        compact
      />
    </div>
  ) : null;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        className={`lm-compact-hero ${disabled ? "is-disabled" : ""}`}
        aria-label={t("common:mode.solidColor")}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => { if (!disabled) setOpen((v) => !v); }}
        style={{
          backgroundColor: hex,
          backgroundImage:
            "linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 55%, rgba(0,0,0,0.08) 100%)",
          boxShadow: `0 8px 24px -8px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.55), inset 0 0 0 1px ${edgeColor}`,
        }}
      >
        <span className="lm-compact-hero-text">
          <span className="lm-compact-hero-hex" style={{ color: textColor }}>
            {hex.toUpperCase()}
          </span>
          <span className="lm-compact-hero-sub" style={{ color: subTextColor }}>
            {sublabel}
          </span>
        </span>
        <span
          aria-hidden
          className="lm-compact-hero-eye"
          style={{ background: eyeBg, color: textColor }}
        >
          <EyedropperIcon />
        </span>
      </button>
      {popover && createPortal(popover, document.body)}
    </div>
  );
}
