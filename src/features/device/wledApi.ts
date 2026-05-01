/**
 * wledApi — v1.5 W1-B4
 *
 * Frontend bridge for the WLED UDP sink Tauri commands defined in
 * `device.ts > DEVICE_COMMANDS`. Mirrors the existing `deviceConnectionApi`
 * shape: thin `invoke()` wrappers, never throws — every response carries
 * a `status.code` discriminator from `WLED_STATUS`.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  DEVICE_COMMANDS,
  type WledDeviceInfo,
  type WledStatusCode,
} from "../../shared/contracts/device";

export interface WledCommandStatus {
  code: WledStatusCode | string;
  message: string;
  details?: string | null;
}

export interface WledDiscoveryResponse {
  status: WledCommandStatus;
  devices: WledDeviceInfo[];
}

export interface WledConnectResponse {
  status: WledCommandStatus;
  /** Echo of the device the host is now bound to, when the connect succeeded. */
  device: WledDeviceInfo | null;
}

export interface WledTestResponse {
  status: WledCommandStatus;
  /** Round-trip latency of the test packet (ms), populated on success. */
  roundTripMs?: number;
}

/**
 * Trigger a passive mDNS / SSDP scan for WLED instances on the local
 * network. Resolves with `WLED_DISCOVERY_OK` (zero-or-more devices) or a
 * specific failure code (`DISCOVERY_TIMEOUT`, etc.). Never throws.
 *
 * Optional `manualIp` short-circuits the scan and probes a single host
 * via the `/json/info` HTTP endpoint — used by the manual IP picker
 * card when the user already knows their WLED's address.
 */
export async function discoverWledDevices(
  manualIp?: string,
): Promise<WledDiscoveryResponse> {
  return invoke<WledDiscoveryResponse>(
    DEVICE_COMMANDS.DISCOVER_WLED_DEVICES,
    manualIp ? { manualIp } : {},
  );
}

/**
 * Bind the persisted active sink to the given WLED device. Idempotent —
 * calling twice with the same args is safe; the bridge does not start
 * streaming until a `set_lighting_mode` arrives.
 */
export async function connectWledSink(
  device: WledDeviceInfo,
): Promise<WledConnectResponse> {
  return invoke<WledConnectResponse>(DEVICE_COMMANDS.CONNECT_WLED_SINK, {
    device,
  });
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
  return invoke<WledTestResponse>(DEVICE_COMMANDS.TEST_WLED_BRIDGE, {
    device,
  });
}
