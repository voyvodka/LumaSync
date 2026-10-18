// Marks only the dock uses.

const PROPS = {
  viewBox: "0 0 16 16",
  width: 15,
  height: 15,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function IconDuplicate() {
  return (
    <svg {...PROPS} aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.2V3a.8.8 0 0 0-.8-.8H3a.8.8 0 0 0-.8.8v6.7a.8.8 0 0 0 .8.8h.2" />
    </svg>
  );
}

/** A stack of rows: what is in the room. */
export function IconTemplates() {
  return (
    <svg {...PROPS} aria-hidden="true">
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="1.6" />
      <path d="M2.2 7h6.3M8.5 2.2v11.6M8.5 10.2h5.3" />
    </svg>
  );
}

export function IconObjects() {
  return (
    <svg {...PROPS} aria-hidden="true">
      <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />
    </svg>
  );
}

/** A plan with its walls: the room itself. */
export function IconRoom() {
  return (
    <svg {...PROPS} aria-hidden="true">
      <path d="M2.5 2.5h11v11h-11z" />
      <path d="M2.5 8.5h4M9.5 2.5v4" />
    </svg>
  );
}

export function IconChevronUp() {
  return (
    <svg viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 6.5 5 3.5l3 3" />
    </svg>
  );
}

/** Back to the list the card was opened from. */
export function IconBack() {
  return (
    <svg {...PROPS} aria-hidden="true">
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </svg>
  );
}

/** A bulb with rays: make the real light blink. */
export function IconIdentify() {
  return (
    <svg {...PROPS} aria-hidden="true">
      <path d="M6.2 10.5a3.4 3.4 0 1 1 3.6 0v1.3H6.2z" />
      <path d="M6.6 13.8h2.8" />
      <path d="M8 1.2v1M2.6 3.4l.7.7M13.4 3.4l-.7.7" />
    </svg>
  );
}
