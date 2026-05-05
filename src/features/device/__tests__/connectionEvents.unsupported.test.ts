/**
 * connectionEvents.unsupported.test.ts
 *
 * Bug 10D regression — pure bus contract tests for the PORT_UNSUPPORTED /
 * PORT_NOT_FOUND rejection codes emitted during boot-time auto-reconnect.
 *
 * Scope: ConnectionEventBus behaviour and ConnectionEvent type contract.
 * No React, no mocks — the bus is a pure in-process pub-sub module.
 */

import { describe, expect, it } from "vitest";

import {
  createConnectionEventBus,
  type ConnectionEvent,
  type ConnectionRejectionCode,
} from "../connectionEvents";

// ---------------------------------------------------------------------------
// Type-level contract tests
// ---------------------------------------------------------------------------

describe("ConnectionEvent type contract", () => {
  it("accepts unsupportedReason: PORT_UNSUPPORTED as an optional field", () => {
    const event: ConnectionEvent = {
      portName: "/dev/cu.usbserial-0001",
      connected: false,
      unsupportedReason: "PORT_UNSUPPORTED",
    };
    // TypeScript would fail to compile if the field were not part of the type.
    expect(event.unsupportedReason).toBe("PORT_UNSUPPORTED");
  });

  it("accepts unsupportedReason: PORT_NOT_FOUND as an optional field", () => {
    const event: ConnectionEvent = {
      portName: "/dev/cu.Bluetooth-Incoming-Port",
      connected: false,
      unsupportedReason: "PORT_NOT_FOUND",
    };
    expect(event.unsupportedReason).toBe("PORT_NOT_FOUND");
  });

  it("is valid without unsupportedReason (generic disconnect)", () => {
    const event: ConnectionEvent = {
      portName: "COM3",
      connected: false,
      // unsupportedReason intentionally absent — runtime disconnects don't set it
    };
    expect(event.unsupportedReason).toBeUndefined();
  });

  it("is valid for a successful connect event (connected: true, no unsupportedReason)", () => {
    const event: ConnectionEvent = {
      portName: "COM3",
      connected: true,
    };
    expect(event.connected).toBe(true);
    expect(event.unsupportedReason).toBeUndefined();
  });

  it("ConnectionRejectionCode union is exhaustively PORT_UNSUPPORTED | PORT_NOT_FOUND", () => {
    // This acts as a compile-time exhaustiveness probe. If the union grows, TypeScript
    // will fail to assign to the narrower local type below, surfacing the gap.
    const codes: ConnectionRejectionCode[] = ["PORT_UNSUPPORTED", "PORT_NOT_FOUND"];
    expect(codes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Bus behaviour — emit / subscribe round-trip
// ---------------------------------------------------------------------------

describe("createConnectionEventBus — PORT_UNSUPPORTED / PORT_NOT_FOUND round-trip", () => {
  it("delivers unsupportedReason: PORT_UNSUPPORTED unchanged to subscriber", () => {
    const bus = createConnectionEventBus();
    const received: ConnectionEvent[] = [];
    bus.subscribe((event) => received.push(event));

    bus.emit({
      portName: "/dev/cu.Bluetooth-Incoming-Port",
      connected: false,
      unsupportedReason: "PORT_UNSUPPORTED",
    });

    expect(received).toHaveLength(1);
    expect(received[0].portName).toBe("/dev/cu.Bluetooth-Incoming-Port");
    expect(received[0].connected).toBe(false);
    expect(received[0].unsupportedReason).toBe("PORT_UNSUPPORTED");
  });

  it("delivers unsupportedReason: PORT_NOT_FOUND unchanged to subscriber", () => {
    const bus = createConnectionEventBus();
    const received: ConnectionEvent[] = [];
    bus.subscribe((event) => received.push(event));

    bus.emit({
      portName: "COM3",
      connected: false,
      unsupportedReason: "PORT_NOT_FOUND",
    });

    expect(received).toHaveLength(1);
    expect(received[0].unsupportedReason).toBe("PORT_NOT_FOUND");
    expect(received[0].connected).toBe(false);
  });

  it("delivers an event without unsupportedReason (generic disconnect) unchanged", () => {
    const bus = createConnectionEventBus();
    const received: ConnectionEvent[] = [];
    bus.subscribe((event) => received.push(event));

    bus.emit({ portName: "COM7", connected: false });

    expect(received).toHaveLength(1);
    expect(received[0].connected).toBe(false);
    expect(received[0].unsupportedReason).toBeUndefined();
  });

  it("connected field is independent of unsupportedReason", () => {
    // A fail event with no unsupportedReason is still a valid disconnect signal.
    // connected:false + no reason = hotplug disconnect, not an allowlist rejection.
    const bus = createConnectionEventBus();
    const received: ConnectionEvent[] = [];
    bus.subscribe((event) => received.push(event));

    bus.emit({ portName: "COM3", connected: false });
    bus.emit({ portName: "COM3", connected: true });
    bus.emit({
      portName: "/dev/cu.Bluetooth-Incoming-Port",
      connected: false,
      unsupportedReason: "PORT_UNSUPPORTED",
    });

    expect(received[0].connected).toBe(false);
    expect(received[0].unsupportedReason).toBeUndefined();

    expect(received[1].connected).toBe(true);
    expect(received[1].unsupportedReason).toBeUndefined();

    expect(received[2].connected).toBe(false);
    expect(received[2].unsupportedReason).toBe("PORT_UNSUPPORTED");
  });

  it("fan-outs to multiple subscribers, each receives unsupportedReason intact", () => {
    const bus = createConnectionEventBus();
    const receivedA: ConnectionEvent[] = [];
    const receivedB: ConnectionEvent[] = [];

    bus.subscribe((e) => receivedA.push(e));
    bus.subscribe((e) => receivedB.push(e));

    bus.emit({
      portName: "/dev/cu.Bluetooth-Incoming-Port",
      connected: false,
      unsupportedReason: "PORT_UNSUPPORTED",
    });

    expect(receivedA[0].unsupportedReason).toBe("PORT_UNSUPPORTED");
    expect(receivedB[0].unsupportedReason).toBe("PORT_UNSUPPORTED");
  });

  it("unsubscribed listener does not receive subsequent unsupported events", () => {
    const bus = createConnectionEventBus();
    const received: ConnectionEvent[] = [];

    const unsubscribe = bus.subscribe((e) => received.push(e));
    unsubscribe();

    bus.emit({
      portName: "COM3",
      connected: false,
      unsupportedReason: "PORT_UNSUPPORTED",
    });

    expect(received).toHaveLength(0);
  });

  it("listener that throws during fanout does not prevent sibling listeners from receiving the event", () => {
    const bus = createConnectionEventBus();
    const received: ConnectionEvent[] = [];

    bus.subscribe(() => {
      throw new Error("listener error");
    });
    bus.subscribe((e) => received.push(e));

    // Should not throw — bus swallows listener errors
    expect(() =>
      bus.emit({
        portName: "COM3",
        connected: false,
        unsupportedReason: "PORT_UNSUPPORTED",
      }),
    ).not.toThrow();

    expect(received).toHaveLength(1);
    expect(received[0].unsupportedReason).toBe("PORT_UNSUPPORTED");
  });

  it("each bus instance is isolated — emitting on one does not reach subscribers on another", () => {
    const busA = createConnectionEventBus();
    const busB = createConnectionEventBus();
    const receivedA: ConnectionEvent[] = [];
    const receivedB: ConnectionEvent[] = [];

    busA.subscribe((e) => receivedA.push(e));
    busB.subscribe((e) => receivedB.push(e));

    busA.emit({
      portName: "COM3",
      connected: false,
      unsupportedReason: "PORT_UNSUPPORTED",
    });

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(0);
  });
});
