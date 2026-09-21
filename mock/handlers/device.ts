/**
 * Serial, WLED and lighting-mode fixtures.
 *
 * Every handler reads `getWorld()` rather than closing over a constant, and the
 * connect handlers write back — `connect_serial_port` has to change what
 * `get_serial_connection_status` answers on the next call, or the mock cannot
 * reproduce anything that goes wrong between a write and a later read.
 */

import { DEVICE_COMMANDS } from "../../src/shared/contracts/device";
import { getWorld, mutate } from "../state";
import type { Handler } from "./types";

const now = () => Date.now();

export const deviceHandlers: Record<string, Handler> = {
  [DEVICE_COMMANDS.LIST_PORTS]: () => {
    const { serial } = getWorld();
    return {
      status: { code: serial.ports.length > 0 ? "SERIAL_PORTS_LISTED" : "SERIAL_NO_PORTS_FOUND" },
      ports: serial.ports.map((p) => ({
        name: p.name,
        kind: p.supported ? "usb" : "other",
        isSupported: p.supported,
        supportReason: p.supported ? "SERIAL_PORT_SUPPORTED" : "SERIAL_PORT_NOT_ALLOWLISTED",
        usb: p.supported
          ? {
              vid: 0x1a86,
              pid: 0x7523,
              manufacturer: "wch.cn",
              product: p.product,
              serialNumber: null,
            }
          : null,
      })),
    };
  },

  [DEVICE_COMMANDS.CONNECT_PORT]: (args) => {
    const portName = typeof args?.portName === "string" ? args.portName : null;
    mutate((w) => {
      w.serial.connectedPort = portName;
    });
    return {
      portName,
      connected: portName !== null,
      status: { code: portName !== null ? "SERIAL_CONNECTED" : "SERIAL_CONNECT_FAILED" },
      updatedAtUnixMs: now(),
    };
  },

  [DEVICE_COMMANDS.GET_CONNECTION_STATUS]: () => {
    const { serial } = getWorld();
    return {
      portName: serial.connectedPort,
      connected: serial.connectedPort !== null,
      status: { code: serial.connectedPort !== null ? "SERIAL_CONNECTED" : "SERIAL_DISCONNECTED" },
      updatedAtUnixMs: now(),
    };
  },

  [DEVICE_COMMANDS.RUN_HEALTH_CHECK]: () => {
    const connected = getWorld().serial.connectedPort !== null;
    return {
      pass: connected,
      steps: [
        {
          step: "PORT_OPEN",
          pass: connected,
          code: connected ? "SERIAL_HEALTH_OK" : "SERIAL_HEALTH_PORT_UNAVAILABLE",
          message: connected ? "Port open" : "No port connected",
          details: null,
        },
      ],
      checkedAtUnixMs: now(),
      roundTripMs: connected ? 12 : undefined,
    };
  },

  [DEVICE_COMMANDS.DISCOVER_WLED_DEVICES]: () => {
    const { wled } = getWorld();
    return {
      status: { code: wled.devices.length > 0 ? "WLED_DISCOVERY_OK" : "WLED_DISCOVERY_EMPTY" },
      devices: wled.devices.map((d) => ({
        host: d.host,
        name: d.name,
        ledCount: d.ledCount,
        version: "0.15.0",
      })),
    };
  },

  [DEVICE_COMMANDS.CONNECT_WLED_SINK]: (args) => {
    const request = args?.request as { host?: string } | undefined;
    const host = typeof request?.host === "string" ? request.host : null;
    mutate((w) => {
      w.wled.connectedHost = host;
    });
    return { status: { code: host !== null ? "WLED_CONNECTED" : "WLED_CONNECT_FAILED" } };
  },

  [DEVICE_COMMANDS.GET_WLED_SINK_STATUS]: () => {
    const { wled } = getWorld();
    return {
      status: { code: wled.connectedHost !== null ? "WLED_CONNECTED" : "WLED_DISCONNECTED" },
      host: wled.connectedHost,
    };
  },

  [DEVICE_COMMANDS.TEST_WLED_BRIDGE]: () => ({
    status: { code: "WLED_TEST_OK" },
  }),

  [DEVICE_COMMANDS.SET_LIGHTING_MODE]: (args) => {
    const mode = typeof args?.mode === "string" ? args.mode : "off";
    const { capture } = getWorld();
    // Ambilight is the only mode that needs the screen, so it is the only one
    // the permission gate can refuse.
    if (mode === "ambilight" && !capture.permissionGranted) {
      return { status: { code: "AMBILIGHT_CAPTURE_PERMISSION_DENIED" } };
    }
    mutate((w) => {
      w.lighting.mode = mode;
    });
    return { status: { code: "LIGHTING_MODE_APPLIED" }, mode };
  },

  [DEVICE_COMMANDS.STOP_LIGHTING]: () => {
    mutate((w) => {
      w.lighting.mode = "off";
    });
    return { status: { code: "LIGHTING_STOPPED" } };
  },

  [DEVICE_COMMANDS.GET_LIGHTING_MODE_STATUS]: () => ({
    status: { code: "LIGHTING_MODE_STATUS_OK" },
    mode: getWorld().lighting.mode,
  }),

  [DEVICE_COMMANDS.GET_RUNTIME_TELEMETRY]: () => {
    const w = getWorld();
    const usbLive = w.serial.connectedPort !== null;
    const hueLive = w.hue.streaming;
    return {
      capturedAtUnixMs: now(),
      capture: {
        framesPerSecond: usbLive || hueLive ? 58.4 : 0,
        lastFrameAgeMs: usbLive || hueLive ? 17 : null,
        error: null,
      },
      usb: {
        connected: usbLive,
        framesPerSecond: usbLive ? 58.4 : 0,
        writeLatencyMs: usbLive ? 3.1 : 0,
      },
      hue: {
        streaming: hueLive,
        packetsPerSecond: hueLive ? 20 : 0,
      },
      queueHealth: "healthy" as const,
    };
  },
};
