import { describe, expect, it, vi } from "vitest";

import type { WledUdpSinkConfig } from "@/shared/contracts/device";
import {
  persistSerialPort,
  persistWledSink,
} from "../outputChannelPersistence";

const SINK: WledUdpSinkConfig = {
  ip: "192.168.1.42",
  port: 4048,
  ledCount: 60,
  protocol: "ddp",
};

// One sink per output channel. If both records survived, both boot paths would
// fire and the serial auto-reconnect — 2 s slower — would evict the WLED sink
// the user just watched come online.
describe("output-channel persistence is mutually exclusive", () => {
  it("clears lastSuccessfulPort when WLED takes the channel", async () => {
    const save = vi.fn().mockResolvedValue(undefined);

    await persistWledSink(save, SINK);

    expect(save).toHaveBeenCalledWith({
      lastWledSink: SINK,
      lastSuccessfulPort: undefined,
    });
  });

  it("clears lastWledSink when serial takes the channel", async () => {
    const save = vi.fn().mockResolvedValue(undefined);

    await persistSerialPort(save, "/dev/cu.usbserial-1420");

    expect(save).toHaveBeenCalledWith({
      lastSuccessfulPort: "/dev/cu.usbserial-1420",
      lastWledSink: undefined,
    });
  });
});
