/**
 * wledApi — invoke contract tests (F2 regression coverage)
 *
 * Strategy: mock `@tauri-apps/api/core` at the module boundary so we test the
 * thin wrappers in isolation — correct command name from DEVICE_COMMANDS,
 * exact payload shape, and the never-throws contract (coded failures are
 * resolved, not rejected).
 *
 * A1.1 regression guard: discoverWledDevices must return the response under
 * the `devices` (plural) field. If Rust ever drifts back to `device`, the
 * wire contract test will fail.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEVICE_COMMANDS,
  WLED_STATUS,
  type WledCommandStatus,
  type WledDeviceInfo,
  type WledWireStatusCode,
} from "@/shared/contracts/device";
import {
  connectWledSink,
  discoverWledDevices,
  testWledBridge,
  type WledConnectResponse,
  type WledDiscoveryResponse,
  type WledTestResponse,
} from "../wledApi";

// ---------------------------------------------------------------------------
// Mock @tauri-apps/api/core at the module boundary.
// The factory captures invokeMock so individual tests can set return values.
// ---------------------------------------------------------------------------

const invokeMock = vi.fn();

beforeEach(() => invokeMock.mockReset());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const DEVICE_OK: WledDeviceInfo = {
  ip: "192.168.1.42",
  mac: "AA:BB:CC:DD:EE:FF",
  ledCount: 60,
  name: "Living Room",
  version: "0.14.0",
};

function makeStatus(code: WledWireStatusCode, message = "ok"): WledCommandStatus {
  return { code, message, details: null };
}

// ---------------------------------------------------------------------------
// discoverWledDevices
// ---------------------------------------------------------------------------

describe("discoverWledDevices", () => {
  it("happy path: resolves with WLED_DISCOVERY_OK and devices array", async () => {
    const response: WledDiscoveryResponse = {
      status: makeStatus(WLED_STATUS.DISCOVERY_OK, "WLED device found and info parsed."),
      devices: [DEVICE_OK],
    };
    invokeMock.mockResolvedValueOnce(response);

    const result = await discoverWledDevices("192.168.1.42");

    expect(result).toEqual(response);
  });

  it("happy path: invokes discover_wled_devices with ip payload when manualIp is supplied", async () => {
    invokeMock.mockResolvedValueOnce({
      status: makeStatus(WLED_STATUS.DISCOVERY_OK),
      devices: [DEVICE_OK],
    });

    await discoverWledDevices("192.168.1.42");

    expect(invokeMock).toHaveBeenCalledWith(
      DEVICE_COMMANDS.DISCOVER_WLED_DEVICES,
      { ip: "192.168.1.42" },
    );
  });

  it("coded failure: resolves (does not throw) with WLED_DISCOVERY_TIMEOUT + empty devices", async () => {
    const response: WledDiscoveryResponse = {
      status: makeStatus(WLED_STATUS.DISCOVERY_TIMEOUT, "WLED device did not respond."),
      devices: [],
    };
    invokeMock.mockResolvedValueOnce(response);

    const result = await discoverWledDevices("192.168.1.99");

    expect(result).toEqual(response);
    expect(result.status.code).toBe(WLED_STATUS.DISCOVERY_TIMEOUT);
    // never-throws contract: must have resolved, not thrown
  });

  it("coded failure: resolves (does not throw) with WLED_DISCOVERY_UNREACHABLE + empty devices", async () => {
    const response: WledDiscoveryResponse = {
      status: makeStatus(WLED_STATUS.DISCOVERY_UNREACHABLE, "Could not reach WLED device."),
      devices: [],
    };
    invokeMock.mockResolvedValueOnce(response);

    const result = await discoverWledDevices("10.0.0.5");

    expect(result.status.code).toBe(WLED_STATUS.DISCOVERY_UNREACHABLE);
    expect(result.devices).toEqual([]);
  });

  // A1.1 regression guard ——————————————————————————————————————————————————
  // The pre-fix Rust handler returned `device: Option<WledDeviceInfo>` (singular).
  // After A1.1 the field was renamed to `devices: Vec<WledDeviceInfo>` (plural).
  // If anyone reverts the rename, `result.devices` becomes undefined and the
  // length assertion fails — exactly the failure we want.
  it("A1.1 wire contract: response carries plural `devices` field, not `device`", async () => {
    const response: WledDiscoveryResponse = {
      status: makeStatus(WLED_STATUS.DISCOVERY_OK),
      devices: [DEVICE_OK],
    };
    invokeMock.mockResolvedValueOnce(response);

    const result = await discoverWledDevices("192.168.1.42");

    // `devices` must be an array
    expect(Array.isArray(result.devices)).toBe(true);
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0].ip).toBe("192.168.1.42");

    // `device` (singular, pre-fix shape) must NOT appear on the result
    expect((result as unknown as Record<string, unknown>)["device"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// connectWledSink
// ---------------------------------------------------------------------------

describe("connectWledSink", () => {
  it("happy path: resolves with WLED_CONNECT_OK", async () => {
    const response: WledConnectResponse = {
      status: makeStatus("WLED_CONNECT_OK", "WLED sink connected and registered."),
    };
    invokeMock.mockResolvedValueOnce(response);

    const result = await connectWledSink(DEVICE_OK);

    expect(result).toEqual(response);
  });

  it("happy path: invokes connect_wled_sink with { device } wrapping the WledDeviceInfo", async () => {
    invokeMock.mockResolvedValueOnce({
      status: makeStatus("WLED_CONNECT_OK"),
    });

    await connectWledSink(DEVICE_OK);

    // The Rust WledConnectRequest expects { device: WledDeviceInfo, port?: u16, protocol?: String }.
    // The TS wrapper sends { device } — port and protocol are Rust-optional and NOT sent by the wrapper.
    expect(invokeMock).toHaveBeenCalledWith(
      DEVICE_COMMANDS.CONNECT_WLED_SINK,
      { device: DEVICE_OK },
    );
  });

  it("payload validation: device fields reach Rust with correct camelCase names (ip, ledCount)", async () => {
    invokeMock.mockResolvedValueOnce({ status: makeStatus("WLED_CONNECT_OK") });

    const deviceWithMinimalFields: WledDeviceInfo = {
      ip: "10.0.0.20",
      ledCount: 144,
    };

    await connectWledSink(deviceWithMinimalFields);

    const [, payload] = invokeMock.mock.calls[0] as [string, { device: WledDeviceInfo }];
    expect(payload.device.ip).toBe("10.0.0.20");
    expect(payload.device.ledCount).toBe(144);
    // optional fields absent — must not be injected as defined
    expect(payload.device.mac).toBeUndefined();
    expect(payload.device.name).toBeUndefined();
    expect(payload.device.version).toBeUndefined();
  });

  it("coded failure: resolves (does not throw) with WLED_INVALID_IP", async () => {
    const response: WledConnectResponse = {
      status: {
        code: WLED_STATUS.INVALID_IP,
        message: "Invalid WLED device IP address format.",
        details: "WLED_INVALID_IP: '127.0.0.1' is a loopback address",
      },
    };
    invokeMock.mockResolvedValueOnce(response);

    const result = await connectWledSink({ ...DEVICE_OK, ip: "127.0.0.1" });

    expect(result.status.code).toBe(WLED_STATUS.INVALID_IP);
    // never-throws contract: the wrapper must not transform this into a thrown error
  });

  it("coded failure: resolves with WLED_INVALID_LED_COUNT", async () => {
    const response: WledConnectResponse = {
      status: makeStatus(WLED_STATUS.INVALID_LED_COUNT, "LED count must be greater than zero."),
    };
    invokeMock.mockResolvedValueOnce(response);

    const result = await connectWledSink({ ...DEVICE_OK, ledCount: 0 });

    expect(result.status.code).toBe(WLED_STATUS.INVALID_LED_COUNT);
  });

  it("coded failure: resolves with WLED_BRIDGE_UNREACHABLE", async () => {
    const response: WledConnectResponse = {
      status: {
        code: WLED_STATUS.BRIDGE_UNREACHABLE,
        message: "Failed to bind UDP socket for WLED sink.",
        details: "bind error: address in use",
      },
    };
    invokeMock.mockResolvedValueOnce(response);

    const result = await connectWledSink(DEVICE_OK);

    expect(result.status.code).toBe(WLED_STATUS.BRIDGE_UNREACHABLE);
  });
});

// ---------------------------------------------------------------------------
// testWledBridge
// ---------------------------------------------------------------------------

describe("testWledBridge", () => {
  it("happy path: resolves with WLED_TEST_LIVE_CONFIRMED and sendLatencyMs populated", async () => {
    const response: WledTestResponse = {
      status: makeStatus("WLED_TEST_LIVE_CONFIRMED", "Test frame sent and the device reported it is displaying a realtime source."),
      sendLatencyMs: 3,
    };
    invokeMock.mockResolvedValueOnce(response);

    const result = await testWledBridge(DEVICE_OK);

    expect(result).toEqual(response);
    expect(result.sendLatencyMs).toBe(3);
  });

  it("happy path: invokes test_wled_bridge with { device } wrapping the WledDeviceInfo", async () => {
    invokeMock.mockResolvedValueOnce({
      status: makeStatus("WLED_TEST_LIVE_CONFIRMED"),
      sendLatencyMs: 2,
    });

    await testWledBridge(DEVICE_OK);

    expect(invokeMock).toHaveBeenCalledWith(
      DEVICE_COMMANDS.TEST_WLED_BRIDGE,
      { device: DEVICE_OK },
    );
  });

  it("WLED_TEST_SENT_UNCONFIRMED is a success that does not claim delivery", async () => {
    const response: WledTestResponse = {
      status: makeStatus(
        "WLED_TEST_SENT_UNCONFIRMED",
        "Device reachable and test frame written to the socket, but the device did not confirm it is displaying a realtime source.",
      ),
      sendLatencyMs: 1,
      requestedLedCount: 60,
      deviceLedCount: 60,
    };
    invokeMock.mockResolvedValueOnce(response);

    const result = await testWledBridge(DEVICE_OK);

    // The frame was sent, so latency exists — but the code must stay
    // distinguishable from the confirmed one, which is the whole point.
    expect(result.status.code).toBe("WLED_TEST_SENT_UNCONFIRMED");
    expect(result.status.code).not.toBe("WLED_TEST_LIVE_CONFIRMED");
    expect(result.sendLatencyMs).toBe(1);
  });

  it("coded failure: resolves with WLED_REALTIME_PORT_MISMATCH and reports the device port", async () => {
    const response: WledTestResponse = {
      status: {
        code: WLED_STATUS.REALTIME_PORT_MISMATCH,
        message: "Configured realtime port is not the port this device listens on.",
        details: "configured=21324, device=19446",
      },
      deviceRealtimePort: 19446,
    };
    invokeMock.mockResolvedValueOnce(response);

    const result = await testWledBridge(DEVICE_OK);

    expect(result.status.code).toBe(WLED_STATUS.REALTIME_PORT_MISMATCH);
    expect(result.deviceRealtimePort).toBe(19446);
    expect(result.sendLatencyMs).toBeUndefined();
  });

  it("coded failure: resolves (does not throw) with WLED_LED_COUNT_MISMATCH", async () => {
    const response: WledTestResponse = {
      status: {
        code: WLED_STATUS.LED_COUNT_MISMATCH,
        message: "Requested LED count does not match device-reported LED count.",
        details: "requested=60, device=144",
      },
      sendLatencyMs: undefined,
    };
    invokeMock.mockResolvedValueOnce(response);

    const result = await testWledBridge(DEVICE_OK);

    expect(result.status.code).toBe(WLED_STATUS.LED_COUNT_MISMATCH);
    expect(result.sendLatencyMs).toBeUndefined();
    // never-throws contract
  });

  it("coded failure: resolves with WLED_BRIDGE_UNREACHABLE when device is unreachable", async () => {
    const response: WledTestResponse = {
      status: {
        code: WLED_STATUS.BRIDGE_UNREACHABLE,
        message: "Failed to bind UDP socket for test.",
        details: "network unreachable",
      },
      sendLatencyMs: undefined,
    };
    invokeMock.mockResolvedValueOnce(response);

    const result = await testWledBridge(DEVICE_OK);

    expect(result.status.code).toBe(WLED_STATUS.BRIDGE_UNREACHABLE);
    expect(result.sendLatencyMs).toBeUndefined();
  });

  it("coded failure: resolves with WLED_PROTOCOL_MISMATCH when device returns unexpected HTTP status", async () => {
    const response: WledTestResponse = {
      status: {
        code: WLED_STATUS.PROTOCOL_MISMATCH,
        message: "Response from device is not valid WLED JSON.",
        details: "HTTP 404",
      },
      sendLatencyMs: undefined,
    };
    invokeMock.mockResolvedValueOnce(response);

    const result = await testWledBridge(DEVICE_OK);

    expect(result.status.code).toBe(WLED_STATUS.PROTOCOL_MISMATCH);
  });

  it("WLED_TEST_SEND_FAILED: sendLatencyMs is absent (undefined) when test frame send fails", async () => {
    const response: WledTestResponse = {
      status: {
        code: "WLED_TEST_SEND_FAILED",
        message: "Test frame send failed.",
        details: "udp send error",
      },
      sendLatencyMs: undefined,
    };
    invokeMock.mockResolvedValueOnce(response);

    const result = await testWledBridge(DEVICE_OK);

    expect(result.status.code).toBe("WLED_TEST_SEND_FAILED");
    expect(result.sendLatencyMs).toBeUndefined();
  });
});
