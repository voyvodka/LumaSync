// Marks for the inspector's size fields: a word's initial differs by language (W/G, H/Y — and
// Turkish height's Y is also the axis), a drawn span does not.

const PROPS = {
  viewBox: "0 0 12 12",
  width: 12,
  height: 12,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function GlyphWidth() {
  return (
    <svg {...PROPS}>
      <path d="M1.5 3.5v5M10.5 3.5v5M3 6h6M4.5 4.5 3 6l1.5 1.5M7.5 4.5 9 6 7.5 7.5" />
    </svg>
  );
}

export function GlyphDepth() {
  return (
    <svg {...PROPS}>
      <path d="M3.5 1.5h5M3.5 10.5h5M6 3v6M4.5 4.5 6 3l1.5 1.5M4.5 7.5 6 9l1.5-1.5" />
    </svg>
  );
}

export function GlyphHeight() {
  return (
    <svg {...PROPS}>
      <path d="M2 10.5h8M6 9V2M4.5 3.5 6 2l1.5 1.5" />
    </svg>
  );
}

/** How far along its wall a cut starts. */
export function GlyphOffset() {
  return (
    <svg {...PROPS}>
      <path d="M1.5 3v6M3 6h7M8.5 4.5 10 6 8.5 7.5" />
    </svg>
  );
}

export function GlyphRotation() {
  return (
    <svg {...PROPS}>
      <path d="M9.8 4.2A4.2 4.2 0 1 0 10.2 7" />
      <path d="M10 1.6v2.8H7.2" />
    </svg>
  );
}
