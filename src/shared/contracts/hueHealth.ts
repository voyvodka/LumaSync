/**
 * The one source of Hue health: a Rust task owns bridge reachability, the
 * stored key, the selected area's readiness and the stream's state, and every
 * window renders the snapshot it publishes. No window polls the bridge.
 * See docs/architecture/hue.md, "One health monitor".
 *
 * Rust handoff: `src-tauri/src/commands/hue/health.rs`.
 */

import type {
  HueOnboardingCommandStatus,
  HueRuntimeStatus,
  HueStreamReadiness,
} from "./hue";

/** None of the three rejects; each answers with the snapshot. */
export const HUE_HEALTH_COMMANDS = {
  /** The snapshot after a local runtime read — never a bridge call. */
  GET_HUE_HEALTH: "get_hue_health",
  /** What the calling window needs; sent on every visibility change. */
  WATCH_HUE_HEALTH: "watch_hue_health",
  /** Re-arms every signal that gave up and reads it at once. */
  RETRY_HUE_HEALTH: "retry_hue_health",
} as const;

/** Broadcast whenever the snapshot's revision moves. */
export const HUE_HEALTH_CHANGED_EVENT = "hue://health";

/** What the last credential probe found. */
export const HUE_BRIDGE_VERDICT = {
  REACHABLE: "reachable",
  /** The bridge answered and refused the key (a Hue-shaped 401/403), or it
   * presented a certificate that is not the paired bridge's: re-pair. */
  CREDENTIAL_REJECTED: "credentialRejected",
  /** The bridge did not answer. */
  UNREACHABLE: "unreachable",
} as const;

export type HueBridgeVerdict = (typeof HUE_BRIDGE_VERDICT)[keyof typeof HUE_BRIDGE_VERDICT];

export interface HueBridgeHealth {
  /** `null` until a probe has completed, and whenever nothing is paired. */
  verdict: HueBridgeVerdict | null;
  /** A probe is in flight. */
  probing: boolean;
  /** The probe stopped after a sustained outage; only a retry re-arms it. */
  gaveUp: boolean;
}

/** The last readiness answer for the saved area, exactly as
 * `check_hue_stream_readiness` gives it. */
export interface HueAreaHealth {
  areaId: string;
  status: HueOnboardingCommandStatus;
  readiness: HueStreamReadiness;
  /** Wall-clock milliseconds of the answer. */
  checkedAtMs: number;
}

export interface HueStreamHealth {
  /** Starting, Running or Reconnecting. */
  active: boolean;
  status: HueRuntimeStatus;
}

export interface HueHealthSnapshot {
  revision: number;
  /** A bridge, an area and a pairing are saved (`toHueStartConfig`). */
  configured: boolean;
  bridge: HueBridgeHealth;
  /** `null` until the saved area has been read; read only while a view watches it. */
  area: HueAreaHealth | null;
  stream: HueStreamHealth;
}

/** `watch_hue_health`'s argument, per window. */
export interface HueHealthWatch {
  visible: boolean;
  /** The Devices view is mounted, visible or not. Rust reads the area only
   * while the window is visible; the flag rising means a view mounted, which
   * starts a check that had given up over. */
  areaReadiness: boolean;
}
