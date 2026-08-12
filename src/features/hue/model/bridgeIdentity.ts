import type { TranslationKey } from "@/features/i18n/catalogue";

import type { HueBridgeSummary } from "../hueOnboardingApi";

// Input-shape UX only, NOT the SSRF guard: this pattern happily accepts
// 127.0.0.1, 0.0.0.0 and 255.255.255.255. The real check is Rust's
// `is_valid_ipv4` in `commands/hue_onboarding.rs`, which rejects loopback,
// unspecified, multicast and broadcast. Never treat this regex as the
// security boundary, and never conclude the Rust guard is redundant.
const IPV4_PATTERN =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

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

export function dedupeBridges(bridges: HueBridgeSummary[]): HueBridgeSummary[] {
  const byId = new Map<string, HueBridgeSummary>();
  for (const bridge of bridges) {
    byId.set(bridge.id, bridge);
  }
  return Array.from(byId.values());
}
