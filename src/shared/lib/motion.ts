/**
 * Whether the user asked the OS for less motion. Checked where JavaScript drives motion
 * (Web Animations, delayed commits, anything waiting on `animationend`); CSS handles its own
 * through `@media (prefers-reduced-motion: reduce)`.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
