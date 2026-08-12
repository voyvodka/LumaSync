/**
 * Coalescing layer over the read-only Hue commands that more than one polling
 * loop asks for. `get_hue_stream_status` is polled by both the App health
 * reconciler and the Devices-tab runtime loop, and while a stream is alive it
 * is NOT a free local read — the Rust handler runs a full readiness round-trip
 * against the bridge. Callers declare the staleness they accept; `maxAgeMs = 0`
 * forces a fresh trip and is mandatory after any mutation.
 */

import { getHueStreamStatus } from "../mode/modeApi";
import { checkHueStreamReadiness } from "./hueOnboardingApi";

/** Well under the shortest status cadence (App health poll, 5 s). */
export const HUE_STATUS_MAX_AGE_MS = 2_000;

/** Same rationale against the 3 s blocked-area readiness cadence. */
export const HUE_READINESS_MAX_AGE_MS = 1_500;

interface CacheEntry<T> {
  value: T;
  at: number;
  inFlight: Promise<T> | null;
}

const entries = new Map<string, CacheEntry<unknown>>();

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function read<T>(key: string, maxAgeMs: number, fetcher: () => Promise<T>): Promise<T> {
  const entry = entries.get(key) as CacheEntry<T> | undefined;

  if (maxAgeMs > 0 && entry) {
    if (entry.inFlight) return entry.inFlight;
    if (entry.at > 0 && now() - entry.at <= maxAgeMs) return Promise.resolve(entry.value);
  }

  const request = fetcher();
  const next: CacheEntry<T> = { value: entry?.value as T, at: entry?.at ?? 0, inFlight: request };
  entries.set(key, next as CacheEntry<unknown>);

  return request
    .then((value) => {
      // A newer forced read may have replaced us; never clobber its result.
      if (entries.get(key) === (next as CacheEntry<unknown>)) {
        next.value = value;
        next.at = now();
        next.inFlight = null;
      }
      return value;
    })
    .catch((error) => {
      if (entries.get(key) === (next as CacheEntry<unknown>)) {
        // Drop the entry entirely: a failed read must not leave a stale
        // timestamp that suppresses the next caller's round-trip.
        entries.delete(key);
      }
      throw error;
    });
}

const STATUS_KEY = "hue:stream-status";

export function readHueStreamStatus(maxAgeMs: number = HUE_STATUS_MAX_AGE_MS) {
  return read(STATUS_KEY, maxAgeMs, () => getHueStreamStatus());
}

/** Drop the cached stream status. Call after any start/stop/restart. */
export function invalidateHueStreamStatus(): void {
  entries.delete(STATUS_KEY);
}

export function readHueStreamReadiness(
  bridgeIp: string,
  username: string,
  areaId: string,
  maxAgeMs: number = HUE_READINESS_MAX_AGE_MS,
) {
  return read(`hue:readiness:${bridgeIp}|${username}|${areaId}`, maxAgeMs, () =>
    checkHueStreamReadiness(bridgeIp, username, areaId),
  );
}

/** Test-only: forget every cached read. */
export function __resetHueReadCacheForTests(): void {
  entries.clear();
}
