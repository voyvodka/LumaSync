import { describe, expect, it, vi } from "vitest";

import type { ShellState } from "@/shared/contracts/shell";
import type { WledUdpSinkConfig } from "@/shared/contracts/device";
import { restoreWledSink, type WledRestoreOutcome } from "../wledSinkRestore";

const SAVED: WledUdpSinkConfig = {
  ip: "192.168.1.42",
  port: 21324,
  ledCount: 60,
  protocol: "warls",
};

function shellState(partial: Partial<ShellState> = {}): ShellState {
  return {
    schemaVersion: 4,
    windowCenterX: null,
    windowCenterY: null,
    lastSection: "lights",
    trayHintShown: false,
    startupEnabled: false,
    ...partial,
  } as ShellState;
}

function discoveryOk(ledCount = 60) {
  return {
    status: { code: "WLED_DISCOVERY_OK", message: "ok", details: null },
    devices: [{ ip: SAVED.ip, ledCount, name: "Desk", version: "0.14.0" }],
  };
}

function buildDeps(overrides: Record<string, unknown> = {}) {
  return {
    loadShellState: vi.fn().mockResolvedValue(shellState({ lastWledSink: SAVED })),
    saveShellState: vi.fn().mockResolvedValue(undefined),
    discover: vi.fn().mockResolvedValue(discoveryOk()),
    connect: vi.fn().mockResolvedValue({
      status: { code: "WLED_CONNECT_OK", message: "ok", details: null },
    }),
    ...overrides,
  };
}

describe("restoreWledSink", () => {
  it("does nothing when no sink was persisted", async () => {
    const deps = buildDeps({
      loadShellState: vi.fn().mockResolvedValue(shellState()),
    });

    const outcome = await restoreWledSink(deps);

    expect(outcome).toEqual({ kind: "no-saved-device" });
    expect(deps.discover).not.toHaveBeenCalled();
    expect(deps.connect).not.toHaveBeenCalled();
  });

  // The whole point of probing first: `connect_wled_sink` binds a local socket
  // and would report success for a device that is not on the network.
  it("never registers the sink when the saved device does not answer", async () => {
    const deps = buildDeps({
      discover: vi.fn().mockResolvedValue({
        status: {
          code: "WLED_DISCOVERY_TIMEOUT",
          message: "no answer",
          details: null,
        },
        devices: [],
      }),
    });

    const outcome = await restoreWledSink(deps);

    expect(deps.connect).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      kind: "failed",
      sink: SAVED,
      status: {
        code: "WLED_DISCOVERY_TIMEOUT",
        message: "no answer",
        details: null,
      },
    });
  });

  it("carries the Rust status code through instead of minting one", async () => {
    const deps = buildDeps({
      connect: vi.fn().mockResolvedValue({
        status: {
          code: "WLED_INVALID_LED_COUNT",
          message: "zero",
          details: null,
        },
      }),
    });

    const outcome = await restoreWledSink(deps);

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.status.code).toBe(
      "WLED_INVALID_LED_COUNT",
    );
  });

  it("replays the persisted port and protocol rather than the DDP default", async () => {
    const deps = buildDeps();

    await restoreWledSink(deps);

    expect(deps.connect).toHaveBeenCalledWith(
      expect.objectContaining({ ip: SAVED.ip }),
      { port: 21324, protocol: "warls" },
    );
  });

  it("adopts the device-reported LED count and re-persists it", async () => {
    const deps = buildDeps({
      discover: vi.fn().mockResolvedValue(discoveryOk(144)),
    });

    const outcome = await restoreWledSink(deps);

    expect(outcome).toEqual({
      kind: "restored",
      sink: { ...SAVED, ledCount: 144 },
    });
    expect(deps.saveShellState).toHaveBeenCalledWith({
      lastWledSink: { ...SAVED, ledCount: 144 },
    });
  });

  it("skips the write when the LED count is unchanged", async () => {
    const deps = buildDeps();

    await restoreWledSink(deps);

    expect(deps.saveShellState).not.toHaveBeenCalled();
  });

  it("resolves with a coded failure instead of throwing when discovery rejects", async () => {
    const deps = buildDeps({
      discover: vi.fn().mockRejectedValue(new Error("ipc down")),
    });

    const outcome = await restoreWledSink(deps);

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.status.code).toBe(
      "WLED_DISCOVERY_UNREACHABLE",
    );
  });

  it("announces restoring before the outcome so a slow probe is visible", async () => {
    const seen: WledRestoreOutcome[] = [];
    const deps = buildDeps({ onOutcome: (o: WledRestoreOutcome) => seen.push(o) });

    await restoreWledSink(deps);

    expect(seen.map((o) => o.kind)).toEqual(["restoring", "restored"]);
  });
});
