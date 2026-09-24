/**
 * wledApi
 *
 * Frontend bridge for the WLED UDP sink Tauri commands defined in
 * `device.ts > DEVICE_COMMANDS`. Mirrors the existing `deviceConnectionApi`
 * shape: thin `invoke()` wrappers, never throws — every response carries
 * a `status.code` discriminator from `WLED_STATUS`.
 */
import {
  DEVICE_COMMANDS,
  type WledConnectResponse,
  type WledDeviceInfo,
  type WledDiscoveryResponse,
  type WledSinkStatus,
  type WledTestResponse,
  type WledUdpSinkConfig,
} from "@/shared/contracts/device";
import { invokeCommand } from "@/shared/ipcApi";

export type {
  WledCommandStatus,
  WledConnectResponse,
  WledDiscoveryResponse,
  WledTestResponse,
} from "@/shared/contracts/device";

/**
 * Port / protocol overrides for a connect. Omitted ⇒ Rust falls back to DDP
 * on 4048, so a restore must pass the persisted pair rather than rely on it.
 */
export type WledTransportOverride = Pick<WledUdpSinkConfig, "port" | "protocol">;

// All three WLED handlers take a single struct parameter named `request`, and
// Tauri matches top-level invoke keys to parameter names: flat args are
// rejected before the handler runs.

/** Probe a single WLED instance's `/json/info` at `ip`. Never throws. */
export async function discoverWledDevices(
  ip: string,
): Promise<WledDiscoveryResponse> {
  return invokeCommand(DEVICE_COMMANDS.DISCOVER_WLED_DEVICES, {
    request: { ip },
  });
}

/**
 * Bind the persisted active sink to the given WLED device. Idempotent —
 * calling twice with the same args is safe; the bridge does not start
 * streaming until a `set_lighting_mode` arrives.
 */
export async function connectWledSink(
  device: WledDeviceInfo,
  transport?: WledTransportOverride,
): Promise<WledConnectResponse> {
  return invokeCommand(DEVICE_COMMANDS.CONNECT_WLED_SINK, {
    request: {
      device,
      port: transport?.port,
      protocol: transport?.protocol,
    },
  });
}

/**
 * Ask Rust which WLED sink is bound right now. Distinct from reading
 * `ShellState.lastWledSink`, which is only the restore intent.
 */
export async function getWledSinkStatus(): Promise<WledSinkStatus> {
  return invokeCommand(DEVICE_COMMANDS.GET_WLED_SINK_STATUS);
}

/**
 * Round-trip a single test packet (typically a red-ramp frame) so the
 * user can confirm reachability + protocol negotiation + LED count match.
 * The Rust handler surfaces `WLED_BRIDGE_UNREACHABLE` /
 * `WLED_PROTOCOL_MISMATCH` / `WLED_LED_COUNT_MISMATCH` instead of
 * generic transport errors so the UI can offer a targeted recovery.
 */
export async function testWledBridge(
  device: WledDeviceInfo,
): Promise<WledTestResponse> {
  return invokeCommand(DEVICE_COMMANDS.TEST_WLED_BRIDGE, {
    request: { device },
  });
}
