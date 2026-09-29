// Shared inline SVG icon set — consolidated from ~9 files where these were duplicated inline.
//
// An icon that sits in an `lm-*` container sizing its svg gets its default size
// from `width`/`height` attributes, not a size utility: utilities outrank the
// components layer, so a class here would override the container's rule.

export function IconCheck() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 6l3 3 5-5" />
    </svg>
  );
}

export function IconInfo() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5M8 11v.5" />
    </svg>
  );
}

export function IconInfoAlt() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 7v4" />
      <circle cx="8" cy="5" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconWifi() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 7.5a12.5 12.5 0 0116 0" />
      <path d="M5 11a8 8 0 0110 0" />
      <path d="M8 14.5a4 4 0 014 0" />
      <circle cx="10" cy="17" r="0.5" fill="currentColor" />
    </svg>
  );
}

export function IconBridge() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="14" height="10" rx="3" />
      <circle cx="10" cy="10" r="2" />
      <path d="M10 5v-2M10 17v-2" />
    </svg>
  );
}

export function IconUsb() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="9" width="18" height="10" rx="2" />
      <path d="M8 9V6a2 2 0 012-2h4a2 2 0 012 2v3" />
      <circle cx="12" cy="14" r="1.3" fill="currentColor" />
    </svg>
  );
}

export function IconHueBridgeGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18M3 12h18" />
    </svg>
  );
}

export function IconRefresh() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 11-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

export function IconLock() {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="10" height="7" rx="1" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

export function IconUnlock() {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="10" height="7" rx="1" />
      <path d="M5 7V5a3 3 0 0 1 6 0" />
    </svg>
  );
}

export function IconOpacity() {
  return (
    <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2v12" />
      <path d="M8 2a6 6 0 0 1 0 12" fill="currentColor" opacity="0.3" />
    </svg>
  );
}

export function IconOff() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <line x1="5" y1="5" x2="19" y2="19" />
    </svg>
  );
}

export function IconAmbilight() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5.5" width="18" height="12" rx="1.5" />
      <path d="M2 9l2-2M22 9l-2-2M2 14l2 2M22 14l-2 2" />
    </svg>
  );
}

export function IconSolid() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
    </svg>
  );
}

/** A four-point spark and a small one: something that moves by itself. */
export function IconEffect() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6z" />
      <path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z" />
    </svg>
  );
}

export function IconSolidDot() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

export function IconGear() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" />
    </svg>
  );
}

export function IconUndo() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h7a3 3 0 1 1 0 6H9" />
      <path d="M6 3L3 6l3 3" />
    </svg>
  );
}

export function IconRedo() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 6H6a3 3 0 1 0 0 6h1" />
      <path d="M10 3l3 3-3 3" />
    </svg>
  );
}

export function IconLockClosed() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="5" width="7" height="5.5" rx="1" />
      <path d="M4 5V3.5a2 2 0 0 1 4 0V5" />
    </svg>
  );
}

export function IconLockOpen() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="5" width="7" height="5.5" rx="1" />
      <path d="M4 5V3.5a2 2 0 0 1 4 0" />
    </svg>
  );
}

export function IconDragHandle() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor" aria-hidden>
      <circle cx="3.5" cy="3" r="0.9" />
      <circle cx="3.5" cy="6" r="0.9" />
      <circle cx="3.5" cy="9" r="0.9" />
      <circle cx="8.5" cy="3" r="0.9" />
      <circle cx="8.5" cy="6" r="0.9" />
      <circle cx="8.5" cy="9" r="0.9" />
    </svg>
  );
}

export function IconMoveTo() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 6h7" />
      <path d="M6 3l3 3-3 3" />
    </svg>
  );
}

export function IconTv() {
  return (
    <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="16" height="11" rx="1.5" />
      <path d="M7 17h6M10 14v3" />
    </svg>
  );
}

export function IconFurniture() {
  return (
    <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10v5h14v-5" />
      <path d="M5 10V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3" />
      <path d="M3 15v2M17 15v2" />
    </svg>
  );
}

export function IconLed() {
  return (
    <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10h14" strokeDasharray="2 3" />
      <circle cx="3" cy="10" r="1.5" fill="currentColor" />
      <circle cx="17" cy="10" r="1.5" fill="currentColor" />
    </svg>
  );
}

export function IconImage() {
  return (
    <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="16" height="14" rx="1.5" />
      <circle cx="7" cy="8" r="1.5" />
      <path d="M18 14l-4-4-3 3-2-2-7 6" />
    </svg>
  );
}

export function IconClose() {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <line x1="3" y1="3" x2="9" y2="9" />
      <line x1="9" y1="3" x2="3" y2="9" />
    </svg>
  );
}

export function IconChevronDown() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4.5 6 7.5 9 4.5" />
    </svg>
  );
}

export function IconPlus() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M6 2v8M2 6h8" />
    </svg>
  );
}

export function IconPencil() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.5 2.5l3 3L6 13H3v-3z" />
    </svg>
  );
}

export function IconTrash() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
    </svg>
  );
}

export function IconChevronUp() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7.5 6 4.5 9 7.5" />
    </svg>
  );
}

export function IconSliders() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7" />
      <circle cx="11" cy="4.5" r="1.5" />
      <circle cx="5" cy="11.5" r="1.5" />
    </svg>
  );
}
