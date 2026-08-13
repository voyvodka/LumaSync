export interface HueAreaState {
  kind: "not-configured" | "no-area" | "ready";
  /** True when an entertainment area id is persisted but no bridge cred is on file. */
  orphanedAreaId: boolean;
}

export function deriveHueAreaState(
  hueBridgeConfigured: boolean,
  hueAreaId: string | null | undefined,
): HueAreaState {
  if (!hueBridgeConfigured) {
    return {
      kind: "not-configured",
      // Surface the "you have an old area id but no bridge to talk to"
      // case so the strip can show a slightly different copy and a
      // clear "re-pair" CTA. The persisted area id is kept (we do NOT
      // clear it here) — the user may simply be offline, and dropping
      // the id would force them to re-pick after every disconnect.
      orphanedAreaId: !!hueAreaId,
    };
  }
  if (!hueAreaId) {
    return { kind: "no-area", orphanedAreaId: false };
  }
  return { kind: "ready", orphanedAreaId: false };
}
