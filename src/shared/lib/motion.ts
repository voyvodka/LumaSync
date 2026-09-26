const OS_QUERY = "(prefers-reduced-motion: reduce)";
/**
 * On the root element while motion is reduced — the Settings choice or the OS request. Stylesheets
 * guard on `:root[data-reduced-motion]` rather than the media query, because a media query cannot
 * be switched on by the app.
 */
const ATTRIBUTE = "data-reduced-motion";

let forced = false;
let followingOs = false;

function osAsks(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(OS_QUERY).matches === true;
}

function sync(): void {
  document.documentElement.toggleAttribute(ATTRIBUTE, forced || osAsks());
}

/**
 * Sets whether the user asked for reduced motion in Settings, and keeps the root attribute on
 * that or the OS request, following the OS live. Called at boot in every window and on every change.
 */
export function applyReducedMotion(userAsks: boolean): void {
  if (typeof document === "undefined") return;
  forced = userAsks;
  sync();
  if (!followingOs && typeof window !== "undefined" && window.matchMedia) {
    followingOs = true;
    window.matchMedia(OS_QUERY).addEventListener?.("change", sync);
  }
}

/**
 * Whether motion is reduced, for motion driven from JavaScript (Web Animations, delayed commits,
 * anything waiting on `animationend`). The OS is asked too, for a window that never set the attribute.
 */
export function prefersReducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.hasAttribute(ATTRIBUTE)) return true;
  return osAsks();
}
