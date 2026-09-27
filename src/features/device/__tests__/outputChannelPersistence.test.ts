import { describe, expect, it } from "vitest";

import type { WledUdpSinkConfig } from "@/shared/contracts/device";
import { DEFAULT_SHELL_STATE, type ShellState } from "@/shared/contracts/shell";
import { persistSerialPort, persistWledSink, type ShellStateUpdater } from "../outputChannelPersistence";

const SINK: WledUdpSinkConfig = {
  ip: "192.168.1.42",
  port: 4048,
  ledCount: 60,
  protocol: "ddp",
};

function storeWith(state: ShellState): { update: ShellStateUpdater; current: () => ShellState } {
  let current = state;
  return {
    update: async (update) => {
      const partial = update(current);
      if (partial) current = { ...current, ...partial };
      return current;
    },
    current: () => current,
  };
}

// One sink per output channel. If both records survived, both boot paths would
// fire and the serial auto-reconnect — 2 s slower — would evict the WLED sink
// the user just watched come online.
describe("output-channel persistence is mutually exclusive", () => {
  it("drops the serial strip's transport when WLED takes the channel, keeping its layout", async () => {
    const store = storeWith({
      ...DEFAULT_SHELL_STATE,
      ledStrips: [
        {
          id: "strip-1",
          enabled: true,
          transport: { kind: "serial", portName: "COM3" },
          hardware: {},
          layout: { totalLeds: 60 } as never,
        },
      ],
    });

    const sink = await persistWledSink(store.update, () => SINK);

    expect(sink).toEqual(SINK);
    expect(store.current().ledStrips).toEqual([
      {
        id: "strip-1",
        enabled: true,
        transport: { kind: "wled", sink: SINK },
        hardware: {},
        layout: { totalLeds: 60 },
      },
    ]);
  });

  it("drops a waiting WLED strip when serial takes the channel", async () => {
    const store = storeWith({
      ...DEFAULT_SHELL_STATE,
      ledStrips: [
        { id: "strip-1", enabled: true, transport: { kind: "serial", portName: "COM3" }, hardware: {} },
        { id: "strip-2", enabled: false, transport: { kind: "wled", sink: SINK }, hardware: {} },
      ],
    });

    await persistSerialPort(store.update, "/dev/cu.usbserial-1420");

    expect(store.current().ledStrips).toEqual([
      { id: "strip-1", enabled: true, transport: { kind: "serial", portName: "/dev/cu.usbserial-1420" }, hardware: {} },
    ]);
  });

  it("hands the WLED sink builder the device saved before", async () => {
    const store = storeWith({
      ...DEFAULT_SHELL_STATE,
      ledStrips: [{ id: "strip-1", enabled: true, transport: { kind: "wled", sink: SINK }, hardware: {} }],
    });
    let seen: WledUdpSinkConfig | undefined;

    await persistWledSink(store.update, (previous) => {
      seen = previous;
      return { ...SINK, ledCount: 90 };
    });

    expect(seen).toEqual(SINK);
  });
});
