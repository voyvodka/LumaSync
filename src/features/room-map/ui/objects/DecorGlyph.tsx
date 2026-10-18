/** A ceiling plan's light, as the plan draws a house light: the shape tells it apart, not a colour. */
export function DecorGlyph({ size = 16 }: { size?: number }) {
  const c = size / 2;
  const r = c - 1.5;
  const arm = r * 0.7;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" stroke="currentColor" strokeWidth={1.25} aria-hidden="true">
      <circle cx={c} cy={c} r={r} strokeDasharray="2.5 1.5" />
      <path d={`M${c - arm} ${c - arm} L${c + arm} ${c + arm} M${c + arm} ${c - arm} L${c - arm} ${c + arm}`} />
    </svg>
  );
}
