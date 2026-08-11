/**
 * hueReadCache — coalescing of the shared Hue read commands.
 *
 * Covers:
 *   - Two readers inside the max-age window share ONE bridge round-trip
 *     (the F9 regression: the App health poll and the Devices runtime loop
 *     each issued their own).
 *   - Concurrent readers share a single in-flight promise.
 *   - `maxAgeMs = 0` forces a fresh trip — the mandatory post-mutation mode.
 *   - `invalidateHueStreamStatus()` drops the cached answer.
 *   - A rejected read is not cached, so the next reader retries.
 *   - Readiness entries are keyed per bridge/user/area.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getHueStreamStatusMock = vi.fn();
const checkHueStreamReadinessMock = vi.fn();

vi.mock("../../mode/modeApi", () => ({
  getHueStreamStatus: () => getHueStreamStatusMock(),
}));

vi.mock("../hueOnboardingApi", () => ({
  checkHueStreamReadiness: (bridgeIp: string, username: string, areaId: string) =>
    checkHueStreamReadinessMock(bridgeIp, username, areaId),
}));

import {
  __resetHueReadCacheForTests,
  invalidateHueStreamStatus,
  readHueStreamReadiness,
  readHueStreamStatus,
} from "../hueReadCache";

describe("hueReadCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetHueReadCacheForTests();
    getHueStreamStatusMock.mockResolvedValue({ status: { state: "Running" } });
    checkHueStreamReadinessMock.mockResolvedValue({ readiness: { ready: true } });
  });

  afterEach(() => {
    __resetHueReadCacheForTests();
  });

  it("serves a second reader inside the max-age window from cache", async () => {
    await readHueStreamStatus();
    await readHueStreamStatus();

    expect(getHueStreamStatusMock).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight promise between concurrent readers", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    getHueStreamStatusMock.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );

    const a = readHueStreamStatus();
    const b = readHueStreamStatus();
    resolve?.({ status: { state: "Running" } });

    await expect(a).resolves.toEqual(await b);
    expect(getHueStreamStatusMock).toHaveBeenCalledTimes(1);
  });

  it("forces a fresh round-trip when maxAgeMs is 0", async () => {
    await readHueStreamStatus();
    await readHueStreamStatus(0);

    expect(getHueStreamStatusMock).toHaveBeenCalledTimes(2);
  });

  it("drops the cached status on invalidate", async () => {
    await readHueStreamStatus();
    invalidateHueStreamStatus();
    await readHueStreamStatus();

    expect(getHueStreamStatusMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed read", async () => {
    getHueStreamStatusMock.mockRejectedValueOnce(new Error("bridge unreachable"));
    await expect(readHueStreamStatus()).rejects.toThrow("bridge unreachable");

    await readHueStreamStatus();
    expect(getHueStreamStatusMock).toHaveBeenCalledTimes(2);
  });

  it("keys readiness entries per bridge, user and area", async () => {
    await readHueStreamReadiness("10.0.0.2", "user", "area-1");
    await readHueStreamReadiness("10.0.0.2", "user", "area-1");
    expect(checkHueStreamReadinessMock).toHaveBeenCalledTimes(1);

    await readHueStreamReadiness("10.0.0.2", "user", "area-2");
    expect(checkHueStreamReadinessMock).toHaveBeenCalledTimes(2);

    await readHueStreamReadiness("10.0.0.9", "user", "area-1");
    expect(checkHueStreamReadinessMock).toHaveBeenCalledTimes(3);
  });
});
