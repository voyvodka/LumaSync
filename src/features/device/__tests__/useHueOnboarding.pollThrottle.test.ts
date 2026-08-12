/**
 * useHueOnboarding — runtime-status poll throttling (F15).
 *
 * `runtimeState` is in the runtime-loop effect's dep array, and it only ever
 * moves because a poll just returned it. The effect used to call `tick()`
 * unconditionally on re-entry, so every transition fired another immediate
 * read of data the hook had just received.
 *
 * The cache layer is mocked out here on purpose: with the real one a second
 * attempt would be absorbed by its TTL and the assertion would pass without
 * the throttle existing at all.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_RUNTIME_TRIGGER_SOURCE } from "@/shared/contracts/hue";

const readHueStreamStatusMock = vi.fn();

vi.mock("../hueReadCache", () => ({
  readHueStreamStatus: (...args: unknown[]) => readHueStreamStatusMock(...args),
  readHueStreamReadiness: vi.fn().mockResolvedValue({}),
  invalidateHueStreamStatus: vi.fn(),
}));

vi.mock("@/features/mode/modeApi", () => ({
  getHueStreamStatus: vi.fn(),
  restartHue: vi.fn(),
  startHue: vi.fn(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: vi.fn().mockResolvedValue({}), save: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../hueOnboardingApi", () => ({
  checkHueStreamReadiness: vi.fn(),
  discoverHueBridges: vi.fn(),
  getHueAreaChannels: vi.fn().mockResolvedValue([]),
  listHueEntertainmentAreas: vi.fn(),
  migrateHueCredentials: vi.fn().mockResolvedValue({
    status: { code: "HUE_CREDENTIAL_MIGRATION_FAILED", message: "no keychain" },
    backend: "plaintext-legacy",
  }),
  pairHueBridge: vi.fn(),
  validateHueCredentials: vi.fn(),
  verifyHueBridgeIp: vi.fn(),
}));

import { useHueOnboarding } from "../useHueOnboarding";

function statusResult(state: string) {
  return {
    active: true,
    status: {
      state,
      code: "OK",
      message: "",
      details: null,
      triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM,
    },
    lastSolidColor: null,
  };
}

describe("useHueOnboarding runtime poll throttle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not re-read status when the transition came from the read itself", async () => {
    readHueStreamStatusMock.mockResolvedValue(statusResult("Running"));

    renderHook(() => useHueOnboarding());

    // Mount tick lands and moves runtimeState null → "Running", re-running the
    // effect. Nothing may poll again on that re-entry.
    await waitFor(() => {
      expect(readHueStreamStatusMock).toHaveBeenCalledTimes(1);
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(readHueStreamStatusMock).toHaveBeenCalledTimes(1);
  });

  it("does not burst on a multi-step transition chain", async () => {
    const states = ["Starting", "Running", "Reconnecting"];
    let call = 0;
    readHueStreamStatusMock.mockImplementation(() =>
      Promise.resolve(statusResult(states[Math.min(call++, states.length - 1)])),
    );

    renderHook(() => useHueOnboarding());

    await waitFor(() => {
      expect(readHueStreamStatusMock).toHaveBeenCalledTimes(1);
    });
    await new Promise((r) => setTimeout(r, 100));

    // Pre-fix this walked the whole chain, one bridge round-trip per step.
    expect(readHueStreamStatusMock).toHaveBeenCalledTimes(1);
  });
});
