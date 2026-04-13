/**
 * UIModeTransitionOverlay — LED edge sweep rendered during Phase 2 of the
 * UI mode transition (compact ↔ full).
 *
 * Four bars light up around the window edge in a clockwise stagger
 * (top → right → bottom → left, +50ms each), mirroring the LED capture →
 * strip flow. Pointer events are disabled so user input still lands on the
 * content underneath. Skipped entirely when `prefers-reduced-motion` is set
 * (the hook never flips `isActive` in that case).
 */
interface UIModeTransitionOverlayProps {
  isActive: boolean;
}

export function UIModeTransitionOverlay({ isActive }: UIModeTransitionOverlayProps) {
  if (!isActive) return null;
  return (
    <div className="lm-led-sweep playing" aria-hidden="true">
      <i className="t" />
      <i className="r" />
      <i className="b" />
      <i className="l" />
    </div>
  );
}
