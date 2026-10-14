/**
 * `Header` is shared by every inspector so the visual rhythm matches
 * `HueZoneInspector` (the reference layout). The chip label is the
 * machine-readable type (translated) and `name` is the user-facing
 * label of the selected object.
 */
export function Header({
  typeLabel,
  name,
  dotColor,
}: {
  typeLabel: string;
  name: string;
  dotColor: string;
}) {
  return (
    <div className="lm-room-dock-inspect-h">
      <span className="lm-room-dock-inspect-h-chip">
        <span
          className="lm-room-dock-inspect-h-chip-dot"
          style={{ background: dotColor }}
          aria-hidden
        />
        <span>{typeLabel}</span>
      </span>
      <span className="sub" title={name}>
        {name}
      </span>
    </div>
  );
}
