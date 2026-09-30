/**
 * Serial, WLED, lighting-mode and telemetry fixtures.
 *
 * Every handler reads `getWorld()` rather than closing over a constant, and the
 * connect handlers write back — `connect_serial_port` has to change what
 * `get_local_outputs` answers on the next call, or the mock cannot
 * reproduce anything that goes wrong between a write and a later read.
 *
 * Shapes here are checked against the real response types by `TypedHandlers`.
 * The first version of this file was written from the command names instead of
 * the DTOs and every one of these was wrong in a way nothing caught.
 */

import { AMBILIGHT_CAPTURE_REASON } from "../../src/shared/contracts/capture";
import {
  DEVICE_HEALTH_STEPS,
  DEVICE_COMMANDS,
  SERIAL_CONNECT_STATUS,
  SERIAL_DISCONNECT_STATUS,
  SERIAL_OUTPUT_STATUS,
  SERIAL_PORT_LIST_STATUS,
  pixelLayoutForChipType,
  type SerialCommandStatusCode,
  type SerialFirmwareInfo,
} from "../../src/shared/contracts/device";
import { HUE_RUNTIME_STATES } from "../../src/shared/contracts/hue";
import type { LightingModeCommandResult, LightingModeConfig } from "../../src/shared/contracts/mode";
import { LINK_MAX_FPS_ABSENT } from "../../src/shared/contracts/telemetry";
import type { HealthStepResult } from "../../src/shared/contracts/device";
import { localOutputsSnapshot } from "../localOutputs";
import { getWorld, mutate, type MockSerialPort } from "../state";
import { hueRuntimeFault } from "./hue";
import { status } from "./status";
import type { TypedHandlers } from "./types";

const now = () => Date.now();

// Obviously synthetic on purpose: nobody should mistake a fixture's advertised
// firmware for a real handshake response. The layout follows the strip the
// port drives, so switching the Settings chip type shows the mismatch marker.
const mockFirmware = (port: MockSerialPort): SerialFirmwareInfo => ({
  version: "9.9",
  versionRaw: 0x0909,
  profile: port.firmwareProfile,
  pixelLayout: pixelLayoutForChipType(port.chipType),
});

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
    const { portName } = args;
    const port = getWorld().serial.ports.find((p) => p.name === portName);
    // Like Rust, a failed attempt leaves a connected strip connected and never
    // reports the attempted name as `portName` — it only appears in `details`.
    // A port that passed admission keeps an entry saying why it is not connected.
    const refused = (code: SerialCommandStatusCode, message: string, detail?: string) => {
      const admitted = port !== undefined && port.supported;
      if (admitted && getWorld().serial.connectedPort !== portName) {
        mutate((w) => {
          w.serial.idleEntry = { portName, code };
        });
      }
      const attempted = `port=${JSON.stringify(portName)}`;
      return {
        portName: null,
        connected: false,
        status: status(code, message, detail ? `${attempted}; ${detail}` : attempted),
        updatedAtUnixMs: now(),
      };
    };
    // The two-stage gate: a port can enumerate and still be refused, and the
    // refusal carries its own code rather than the generic failure.
    if (port === undefined) {
      return refused("PORT_NOT_FOUND", "No such port");
    }
    if (!port.supported) {
      return refused(
        "PORT_UNSUPPORTED",
        "Not on the VID/PID allowlist",
        `${port.vid.toString(16)}:${port.pid.toString(16)}`,
      );
    }
    if (port.connectOutcome !== "OK") {
      return refused(SERIAL_CONNECT_STATUS[port.connectOutcome], "Open refused");
    }
    // The WLED device stays bound, as in Rust's registry; whichever was connected first is driven.
    // One strip at a time in the world: a second port stands for the switch that follows it in the app,
    // which lets the first go.
    mutate((w) => {
      const previous = w.serial.connectedPort;
      if (previous === null) w.serial.connectedFirst = w.wled.connectedHost !== null ? "wled" : "serial";
      w.serial.connectedPort = portName;
      w.serial.idleEntry =
        previous !== null && previous !== portName
          ? { portName: previous, code: SERIAL_OUTPUT_STATUS.DISCONNECTED }
          : null;
    });
    return {
      portName,
      connected: true,
      status: status(SERIAL_CONNECT_STATUS.OK, "Connected"),
      updatedAtUnixMs: now(),
      firmware: mockFirmware(port),
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
      roundTripMs: failed ? null : 12,
      firmwareVersion: failed || port === undefined ? null : mockFirmware(port).version,
      advertisedFirmwareProfile: failed ? null : (port?.firmwareProfile ?? null),
      firmware: failed || port === undefined ? undefined : mockFirmware(port),
    };
  },

  [DEVICE_COMMANDS.DISCOVER_WLED_DEVICES]: (args) => {
    const { wled } = getWorld();
    // The device at that address when the world has one; any other address finds them all.
    const at = wled.devices.filter((d) => d.host === args.request.ip);
    const devices = at.length > 0 ? at : wled.devices;
    return {
      status: status(
        // There is no "empty" code: discovery either answered, timed out, or
        // could not be reached. An empty list under OK is the honest shape.
        devices.length > 0 ? "WLED_DISCOVERY_OK" : "WLED_DISCOVERY_UNREACHABLE",
        `${devices.length} device(s)`,
      ),
      devices: devices.map((d) => ({
        ip: d.host,
        name: d.name,
        ledCount: d.ledCount,
        version: "0.15.0-mock",
      })),
    };
  },

  [DEVICE_COMMANDS.BROWSE_WLED_DEVICES]: () => {
    const { wled } = getWorld();
    return {
      status: status("WLED_BROWSE_OK", `${wled.devices.length} device(s)`),
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
    // than it looks; reading `request.ip` used to silently match nothing.
    const host = args.request.device.ip;
    const device = getWorld().wled.devices.find((d) => d.host === host);
    if (device === undefined) {
      return { status: status("WLED_BRIDGE_UNREACHABLE", "No such device") };
    }
    mutate((w) => {
      if (w.wled.connectedHost === null) w.serial.connectedFirst = w.serial.connectedPort !== null ? "serial" : "wled";
      w.wled.connectedHost = host;
    });
    return { status: status("WLED_CONNECT_OK", "Connected") };
  },

  /** The registry as the world holds it; see `mock/localOutputs.ts`. */
  [DEVICE_COMMANDS.GET_LOCAL_OUTPUTS]: () => localOutputsSnapshot(),

  [DEVICE_COMMANDS.DISCONNECT_SERIAL_PORT]: (args) => {
    const { portName } = args;
    if (getWorld().serial.connectedPort !== portName) {
      return { portName, status: status(SERIAL_DISCONNECT_STATUS.NOT_CONNECTED, "That strip is not connected.") };
    }
    mutate((w) => {
      w.serial.connectedPort = null;
      w.serial.idleEntry = { portName, code: SERIAL_OUTPUT_STATUS.DISCONNECTED };
    });
    return { portName, status: status(SERIAL_DISCONNECT_STATUS.OK, "The strip was disconnected.") };
  },

  /** Three live outcomes, not one: confirmed, sent-unconfirmed, and failed. */
  [DEVICE_COMMANDS.TEST_WLED_BRIDGE]: () => ({
    status: status(getWorld().wled.testOutcome, "Test frame"),
  }),

  /**
   * Five minutes ending now, one sample a second, with a half-minute gap where
   * the lights were off — the case a line through zero would get wrong.
   * Empty while nothing captures, like a fresh app.
   */
  [DEVICE_COMMANDS.GET_RUNTIME_TELEMETRY_HISTORY]: () => {
    const t = getWorld().telemetry;
    if (t.captureTargetFps === 0) return { samples: [] };
    const end = Math.floor(now() / 1000) * 1000;
    const samples = [];
    for (let age = 299; age >= 0; age -= 1) {
      if (age >= 170 && age < 200) continue;
      const wobble = Math.sin(age / 7) * 2 + Math.sin(age / 23) * 3;
      const dip = age > 90 && age < 110 ? 12 : 0;
      const fps = Math.max(0, Math.min(t.captureTargetFps, t.captureFps + wobble - dip));
      samples.push({ epochMs: end - age * 1000, fps: Math.round(fps * 100) / 100, targetFps: t.captureTargetFps });
    }
    return { samples };
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
    // Reuses `hueRuntimeFault` from `hue.ts` rather than re-deriving it from
    // `reachable`/`credentialValid` here: this handler used to report "Idle"
    // for both an unreachable bridge and an expired key, collapsing exactly
    // the distinction `get_hue_stream_status` already got right.
    const fault = hueRuntimeFault(w.hue);
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
        captureTargetFps: t.captureTargetFps,
        lastOutputErrorCode: t.lastOutputErrorCode,
        lastOutputErrorAtSecs: t.lastOutputErrorAtSecs,
        workerStopped: t.workerStopped,
      },
      hue: w.hue.everActive
        ? {
            state: w.hue.streaming
              ? HUE_RUNTIME_STATES.RUNNING
              : (fault?.state ?? HUE_RUNTIME_STATES.IDLE),
            uptimeSecs: w.hue.streaming ? 128 : null,
            packetRate: w.hue.streaming ? 20 : 0,
            lastErrorCode: w.hue.streaming ? null : (fault?.code ?? null),
            lastErrorAtSecs: w.hue.streaming ? null : fault !== null ? 4 : null,
            totalReconnects: w.hue.totalReconnects,
            // Mirrors `session_reconnect_success` /
            // `session_reconnect_total.saturating_sub(session_reconnect_success)`
            // in `runtime_telemetry.rs`: a bridge still unreachable has never
            // *succeeded* a reconnect, so every attempt so far counts as failed.
            successfulReconnects:
              fault?.state === HUE_RUNTIME_STATES.RECONNECTING ? 0 : w.hue.totalReconnects,
            failedReconnects:
              fault?.state === HUE_RUNTIME_STATES.RECONNECTING ? w.hue.totalReconnects : 0,
            dtlsActive: w.hue.streaming,
            dtlsCipher: w.hue.streaming ? "TLS_PSK_WITH_AES_128_GCM_SHA256" : null,
            dtlsConnectedAtSecs: w.hue.streaming ? 128 : null,
          }
        : null,
    };
  },
} satisfies TypedHandlers;

/**
 * The bare mode apply under the lighting transaction — `apply_config_blocking`
 * in Rust, which no command reaches on its own any more. `apply_outputs` in
 * `./lighting.ts` builds on it.
 */
export function applyLightingMode(payload: LightingModeConfig): LightingModeCommandResult {
  const { kind, targets } = payload;
  const w = getWorld();

  // Target derivation mirrors `apply_mode_change_inner`
  // (`src-tauri/src/commands/lighting_mode.rs:2004-2008`): empty/absent
  // `targets` means USB-required for backward compat; "hue" opts a
  // mode into the Hue gate below. Order matters — the USB gate (2023-2036)
  // runs before the Hue gate (2039-2052) in Rust, so it must here too: a
  // request needing both with neither available reports DEVICE_NOT_CONNECTED,
  // not HUE_NOT_READY.
  const requestedTargets = targets ?? [];
  const needsUsb = requestedTargets.length === 0 || requestedTargets.includes("usb");
  const needsHue = requestedTargets.includes("hue");

  // USB gate (`lighting_mode.rs:2016-2036`). A registered WLED sink
  // satisfies it the same way `UsbOutputPlan::Wled` does in Rust, even with
  // no serial port connected — `usb_available = device_connected ||
  // usb_plan.is_some()`.
  const usbAvailable = w.serial.connectedPort !== null || w.wled.connectedHost !== null;
  if (kind !== "off" && needsUsb && !usbAvailable) {
    return {
      active: w.lighting.mode.kind !== "off",
      mode: w.lighting.mode,
      wledAdvisory: null,
      status: status(
        "DEVICE_NOT_CONNECTED",
        "Cannot apply lighting mode while device is disconnected.",
        "Connect a supported serial controller before changing mode.",
      ),
    };
  }

  // Hue gate (`lighting_mode.rs:2039-2052`). `hue_output` there is `Some`
  // only once `start_hue_stream` has actually spawned a sender —
  // `snapshot_hue_output_context` (`hue/state_store.rs:451-463`) reads
  // `owner.active_stream`, which is set only at start's step 4c and cleared
  // by every stop/gate-block/abort/reconnect path (`hue/retry.rs:150,187,303`,
  // `hue/reconnect.rs:167,416`). Never-started, `Idle`/gate-blocked,
  // `Reconnecting` and `Failed` all leave it `None` — only a genuinely
  // `Running` stream leaves it `Some`. `hue.streaming` is the mock's proxy
  // for that same fact (see `hueRuntimeFault` in `./hue.ts`, which is what
  // flips it false on every fault branch).
  if (kind !== "off" && needsHue && !w.hue.streaming) {
    return {
      active: w.lighting.mode.kind !== "off",
      mode: w.lighting.mode,
      wledAdvisory: null,
      status: status(
        "HUE_NOT_READY",
        "Hue streaming is not available. Ensure bridge is paired and entertainment area is selected.",
        "HUE_RUNTIME_GATE_FAILED",
      ),
    };
  }

  // Ambilight is the only mode that needs the screen, so it is the only one
  // the permission gate can refuse.
  if (kind === "ambilight" && !w.capture.permissionGranted) {
    return {
      active: false,
      mode: w.lighting.mode,
      wledAdvisory: null,
      // `details` carries the bare capture reason, read by `describeCaptureFailure`
      // — Rust never leaves it `null` on this status (`lighting_mode.rs`).
      status: status(
        "AMBILIGHT_MODE_START_FAILED",
        "Ambilight runtime could not start.",
        AMBILIGHT_CAPTURE_REASON.PERMISSION_DENIED,
      ),
    };
  }
  mutate((draft) => {
    // `targets` too: the reply's `mode` is what the backend runs, and the
    // delta-start paths read Hue and USB membership off it.
    draft.lighting.mode = { ...draft.lighting.mode, kind, targets };
  });
  return {
    active: kind !== "off",
    mode: getWorld().lighting.mode,
    wledAdvisory: null,
    status: status(
      kind === "ambilight"
        ? "AMBILIGHT_MODE_STARTED"
        : kind === "effect"
          ? "EFFECT_MODE_STARTED"
          : "SOLID_MODE_APPLIED",
      "Mode applied",
    ),
  };
}

/** `stop_lighting_blocking`: Off, under the same transaction. */
export function stopLightingMode(): LightingModeCommandResult {
  mutate((w) => {
    w.lighting.mode = { ...w.lighting.mode, kind: "off" as never };
  });
  return {
    active: false,
    mode: getWorld().lighting.mode,
    wledAdvisory: null,
    status: status("LIGHTING_MODE_STOPPED", "Stopped"),
  };
}
