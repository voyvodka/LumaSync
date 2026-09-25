import type { TranslationKey } from "@/features/i18n/catalogue";

import type { HueBridgeSummary } from "../hueOnboardingApi";

// Input-shape UX only, NOT the SSRF guard: this pattern happily accepts
// 127.0.0.1, 0.0.0.0, 255.255.255.255 and public addresses. The real check is
// Rust's `validate_bridge_addr` in `commands/hue/transport/address.rs`, which
// accepts local-network addresses only. Never treat this regex as the
// security boundary, and never conclude the Rust guard is redundant.
const IPV4_PATTERN =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

// `bridge.ip` is an identifier to hand to Rust, never a URL to build from here.
// Rust owns HTTPS-first and the downgrade rules; a frontend fetch bypasses both.
export function normalizeIpValue(value: string): string {
  return value.trim();
}

export function resolveManualIpError(value: string): TranslationKey | null {
  const normalized = normalizeIpValue(value);
  if (normalized.length === 0) {
    return null;
  }

  return IPV4_PATTERN.test(normalized) ? null : "hue:manualIp.invalid";
}

/** Cloud discovery reports a bridge id in lower case, `/api/config` in upper case. */
export function sameBridgeId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** One entry per bridge, the first one listed winning — callers list the
 * freshest answer first. Last-wins kept a bridge's old address after DHCP
 * moved it, since every caller put the fresh answer ahead of the old list. */
export function dedupeBridges(bridges: HueBridgeSummary[]): HueBridgeSummary[] {
  const byId = new Map<string, HueBridgeSummary>();
  for (const bridge of bridges) {
    const key = bridge.id.toLowerCase();
    if (!byId.has(key)) byId.set(key, bridge);
  }
  return Array.from(byId.values());
}

/** `bridge` at the address a fresh answer found it at, keeping its identity,
 * or `null` when the answer does not place it anywhere new. */
export function relocatedBridge(
  bridge: HueBridgeSummary,
  fresh: readonly HueBridgeSummary[],
): HueBridgeSummary | null {
  const found = fresh.find((candidate) => sameBridgeId(candidate.id, bridge.id));
  return found && found.ip !== bridge.ip ? { ...bridge, ip: found.ip } : null;
}
