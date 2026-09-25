export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/60";

/** One option of a dock choice group; `layout` carries what differs between the groups. */
export function dockChoiceClass(active: boolean, layout: string): string {
  return `min-h-8 rounded-md border py-1.5 tracking-[0.1em] transition-colors ${FOCUS_RING} ${layout} ${
    active
      ? "border-amber/40 bg-amber/10 text-amber"
      : "border-line-2 bg-panel text-ink-dim hover:border-line-2"
  }`;
}
