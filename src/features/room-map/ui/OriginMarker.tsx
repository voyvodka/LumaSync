interface OriginMarkerProps {
  /** Room width in metres */
  widthM: number;
  /** Room depth in metres */
  depthM: number;
  pxPerMeter: number;
}

/** Large enough extent (in px) to cover any reasonable pan/zoom range */
const EXTENT_M = 100;

/**
 * Non-interactive crosshair always centered at room midpoint.
 * Lines extend far beyond room boundaries to appear "infinite".
 */
export function OriginMarker({ widthM, depthM, pxPerMeter }: OriginMarkerProps) {
  const cx = (widthM / 2) * pxPerMeter;
  const cy = (depthM / 2) * pxPerMeter;
  const ext = EXTENT_M * pxPerMeter;

  return (
    <svg className="pointer-events-none absolute" style={{ zIndex: 5, left: 0, top: 0, overflow: "visible" }} width={1} height={1}>
      {/* Horizontal line — extends far left/right */}
      <line x1={cx - ext} y1={cy} x2={cx + ext} y2={cy} stroke="#f43f5e" strokeWidth={1} strokeDasharray="4 3" opacity={0.45} />
      {/* Vertical line — extends far up/down */}
      <line x1={cx} y1={cy - ext} x2={cx} y2={cy + ext} stroke="#f43f5e" strokeWidth={1} strokeDasharray="4 3" opacity={0.45} />
      {/* Center dot */}
      <circle cx={cx} cy={cy} r={2.5} fill="#f43f5e" opacity={0.6} />
    </svg>
  );
}
