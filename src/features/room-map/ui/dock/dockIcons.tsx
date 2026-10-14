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
