/**
 * Serial, WLED, lighting-mode and telemetry fixtures.
 *
 * Every handler reads `getWorld()` rather than closing over a constant, and the
 * connect handlers write back — `connect_serial_port` has to change what
 * `get_serial_connection_status` answers on the next call, or the mock cannot
 * reproduce anything that goes wrong between a write and a later read.
 *
 * Shapes here are checked against the real response types by `TypedHandlers`.
 * The first version of this file was written from the command names instead of
 * the DTOs and every one of these was wrong in a way nothing caught.
 */

import {
  DEVICE_HEALTH_STEPS,
  DEVICE_COMMANDS,
  SERIAL_CONNECT_STATUS,
  SERIAL_PORT_LIST_STATUS,
} from "../../src/shared/contracts/device";
import { LINK_MAX_FPS_ABSENT } from "../../src/shared/contracts/telemetry";
import type { HealthStepResult } from "../../src/features/device/deviceConnectionApi";
import { getWorld, mutate } from "../state";
import { status } from "./status";
import type { TypedHandlers } from "./types";

const now = () => Date.now();

export const deviceHandlers = {
  [DEVICE_COMMANDS.LIST_PORTS]: () => {
    const { serial } = getWorld();
    return {
      status: status(SERIAL_PORT_LIST_STATUS.OK, `${serial.ports.length} port(s)`),
      ports: serial.ports.map((p) => ({
        name: p.name,
        kind: p.supported ? "usb" : "other",
        isSupported: p.supported,
        supportReason: p.supported ? "PORT_SUPPORTED" : "PORT_UNSUPPORTED",
        usb: p.supported
          ? {
              vid: p.vid,
              pid: p.pid,
              manufacturer: p.manufacturer,
              product: p.product,
              serialNumber: null,
            }
          : null,
      })),
    };
  },

  [DEVICE_COMMANDS.CONNECT_PORT]: (args) => {
    const portName = typeof args?.portName === "string" ? args.portName : null;
    const port = getWorld().serial.ports.find((p) => p.name === portName);
    // The two-stage gate: a port can enumerate and still be refused, and the
    // refusal carries its own code rather than the generic failure.
    if (port === undefined) {
      return {
        portName,
        connected: false,
        status: status("PORT_NOT_FOUND", "No such port"),
        updatedAtUnixMs: now(),
      };
    }
    if (!port.supported) {
      return {
        portName,
        connected: false,
        status: status(
          "PORT_UNSUPPORTED",
          "Not on the VID/PID allowlist",
          `${port.vid.toString(16)}:${port.pid.toString(16)}`,
        ),
        updatedAtUnixMs: now(),
      };
    }
    if (port.connectOutcome !== "OK") {
      return {
        portName,
        connected: false,
        status: status(SERIAL_CONNECT_STATUS[port.connectOutcome], "Open refused"),
        updatedAtUnixMs: now(),
      };
    }
    mutate((w) => {
      w.serial.connectedPort = portName;
    });
    return {
      portName,
      connected: true,
      status: status(SERIAL_CONNECT_STATUS.OK, "Connected"),
      updatedAtUnixMs: now(),
    };
  },

  [DEVICE_COMMANDS.GET_CONNECTION_STATUS]: () => {
    const { serial } = getWorld();
    const connected = serial.connectedPort !== null;
    return {
      portName: serial.connectedPort,
      connected,
      status: connected
        ? status(SERIAL_CONNECT_STATUS.OK, "Connected")
        : status(SERIAL_CONNECT_STATUS.IDLE, "Nothing connected"),
      updatedAtUnixMs: now(),
    };
  },

  /**
   * The real check walks four stages and each can fail on its own. Collapsing
   * it to one boolean made the health modal unable to show a stage failing, a
   * firmware version, or the profile mismatch that shipped as a bug.
   */
  [DEVICE_COMMANDS.RUN_HEALTH_CHECK]: () => {
    const { serial } = getWorld();
    const port = serial.ports.find((p) => p.name === serial.connectedPort);
    const failAt = getWorld().serial.healthFailsAt;
    const ORDER = [
      DEVICE_HEALTH_STEPS.PORT_VISIBLE,
      DEVICE_HEALTH_STEPS.PORT_SUPPORTED,
      DEVICE_HEALTH_STEPS.CONNECT_AND_VERIFY,
      DEVICE_HEALTH_STEPS.HANDSHAKE,
    ] as const;

    const steps: HealthStepResult[] = [];
    let failed = false;
    for (const step of ORDER) {
      if (failed) break;
      const fails = failAt === step || port === undefined;
      steps.push({
        step,
        pass: !fails,
        // A passing step reports its own name as its code — see the contract.
        code: fails ? SERIAL_CONNECT_STATUS.FAILED : step,
        message: fails ? `${step} failed` : `${step} ok`,
        details: null,
      });
      if (fails) failed = true;
    }

    return {
      pass: !failed,
      steps,
      checkedAtUnixMs: now(),
      roundTripMs: failed ? undefined : 12,
      // Obviously synthetic on purpose: nobody should mistake a fixture's
      // advertised firmware for a real handshake response.
      firmwareVersion: failed ? undefined : "9.9.9-mock",
      advertisedFirmwareProfile: failed ? undefined : port?.firmwareProfile,
    };
  },

  [DEVICE_COMMANDS.DISCOVER_WLED_DEVICES]: () => {
    const { wled } = getWorld();
    return {
      status: status(
        // There is no "empty" code: discovery either answered, timed out, or
        // could not be reached. An empty list under OK is the honest shape.
        wled.devices.length > 0 ? "WLED_DISCOVERY_OK" : "WLED_DISCOVERY_UNREACHABLE",
        `${wled.devices.length} device(s)`,
      ),
      devices: wled.devices.map((d) => ({
        ip: d.host,
        name: d.name,
        ledCount: d.ledCount,
        version: "0.15.0-mock",
      })),
    };
  },

  [DEVICE_COMMANDS.CONNECT_WLED_SINK]: (args) => {
    // `{ request: { device, port, protocol } }` — the ip is a level deeper
    // than it looks, and reading `request.ip` silently matched nothing.
    const request = args?.request as { device?: { ip?: string } } | undefined;
    const host = typeof request?.device?.ip === "string" ? request.device.ip : null;
    const device = getWorld().wled.devices.find((d) => d.host === host);
    if (device === undefined) {
      return { status: status("WLED_BRIDGE_UNREACHABLE", "No such device") };
    }
    mutate((w) => {
      w.wled.connectedHost = host;
    });
    return { status: status("WLED_CONNECT_OK", "Connected") };
  },

  [DEVICE_COMMANDS.GET_WLED_SINK_STATUS]: () => {
    const { wled } = getWorld();
    const device = wled.devices.find((d) => d.host === wled.connectedHost);
    return {
      connected: device !== undefined,
      sink:
        device === undefined
          ? null
          : { ip: device.host, port: device.port, ledCount: device.ledCount, protocol: device.protocol },
    };
  },

  /** Three live outcomes, not one: confirmed, sent-unconfirmed, and failed. */
  [DEVICE_COMMANDS.TEST_WLED_BRIDGE]: () => ({
    status: status(getWorld().wled.testOutcome, "Test frame"),
  }),

  [DEVICE_COMMANDS.SET_LIGHTING_MODE]: (args) => {
    const requested = args?.mode as { kind?: string } | undefined;
    const kind = typeof requested?.kind === "string" ? requested.kind : "off";
    const w = getWorld();
    // Ambilight is the only mode that needs the screen, so it is the only one
    // the permission gate can refuse.
    if (kind === "ambilight" && !w.capture.permissionGranted) {
      return {
        active: false,
        mode: w.lighting.mode,
        status: status("AMBILIGHT_MODE_START_FAILED", "Screen recording permission denied"),
      };
    }
    mutate((draft) => {
      draft.lighting.mode = { ...draft.lighting.mode, kind: kind as never };
    });
    return {
      active: kind !== "off",
      mode: getWorld().lighting.mode,
      status: status(
        kind === "ambilight" ? "AMBILIGHT_MODE_STARTED" : "SOLID_MODE_APPLIED",
        "Mode applied",
      ),
    };
  },

  [DEVICE_COMMANDS.STOP_LIGHTING]: () => {
    mutate((w) => {
      w.lighting.mode = { ...w.lighting.mode, kind: "off" as never };
    });
    return {
      active: false,
      mode: getWorld().lighting.mode,
      status: status("LIGHTING_MODE_STOPPED", "Stopped"),
    };
  },

  [DEVICE_COMMANDS.GET_LIGHTING_MODE_STATUS]: () => {
    const w = getWorld();
    return {
      active: w.lighting.mode.kind !== "off",
      mode: w.lighting.mode,
      status: status("LIGHTING_MODE_STATUS_OK", "Current mode"),
    };
  },

  /**
   * `FullTelemetrySnapshot` is `{usb, hue|null}`. `hue: null` is a third state
   * beyond streaming and idle — "Hue has not been active this session" — and
   * `linkMaxFps` uses a sentinel for absent rather than zero, which is exactly
   * the distinction the readout once got wrong.
   */
  [DEVICE_COMMANDS.GET_RUNTIME_TELEMETRY]: () => {
    const w = getWorld();
    const t = w.telemetry;
    const usbLive = w.serial.connectedPort !== null;
    return {
      usb: {
        captureFps: t.captureFps,
        sendFps: t.sendFps,
        queueHealth: t.queueHealth,
        frameLatencyMs: t.frameLatencyMs,
        linkConstrained: t.linkConstrained,
        linkMaxFps: usbLive ? t.linkMaxFps : LINK_MAX_FPS_ABSENT,
        lastCaptureErrorCode: t.lastCaptureErrorCode,
        lastCaptureErrorAtSecs: t.lastCaptureErrorAtSecs,
      },
      hue: w.hue.everActive
        ? {
            state: w.hue.streaming ? "Running" : "Idle",
            uptimeSecs: w.hue.streaming ? 128 : null,
            packetRate: w.hue.streaming ? 20 : 0,
            lastErrorCode: null,
            lastErrorAtSecs: null,
            totalReconnects: w.hue.totalReconnects,
            successfulReconnects: w.hue.totalReconnects,
            failedReconnects: 0,
            dtlsActive: w.hue.streaming,
            dtlsCipher: w.hue.streaming ? "TLS_PSK_WITH_AES_128_GCM_SHA256" : null,
            dtlsConnectedAtSecs: w.hue.streaming ? 128 : null,
          }
        : null,
    };
  },
} satisfies TypedHandlers;
