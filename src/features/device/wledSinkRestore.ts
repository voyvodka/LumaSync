/** Boot-time re-bind of `ShellState.lastWledSink`. Probes `/json/info` first: `connect_wled_sink` only binds a local socket, so a blind restore reports success and then streams into the void. */
import type { ShellState } from "@/shared/contracts/shell";
import {
  WLED_STATUS,
  type WledDeviceInfo,
  type WledUdpSinkConfig,
} from "@/shared/contracts/device";
import type {
  WledCommandStatus,
  WledConnectResponse,
  WledDiscoveryResponse,
  WledTransportOverride,
} from "./wledApi";

export type WledRestoreOutcome =
  | { kind: "idle" }
  | { kind: "no-saved-device" }
  | { kind: "restoring"; sink: WledUdpSinkConfig }
  | { kind: "restored"; sink: WledUdpSinkConfig }
  | { kind: "failed"; sink: WledUdpSinkConfig; status: WledCommandStatus };

export interface WledSinkRestoreDeps {
  loadShellState: () => Promise<ShellState>;
  saveShellState: (partial: Partial<ShellState>) => Promise<void>;
  discover: (ip: string) => Promise<WledDiscoveryResponse>;
  connect: (
    device: WledDeviceInfo,
    transport?: WledTransportOverride,
  ) => Promise<WledConnectResponse>;
  onOutcome?: (outcome: WledRestoreOutcome) => void;
}

/** Never throws — a transport fault resolves as `failed` carrying the Rust status, so no caller invents a code. */
export async function restoreWledSink(
  deps: WledSinkRestoreDeps,
): Promise<WledRestoreOutcome> {
  const emit = (outcome: WledRestoreOutcome): WledRestoreOutcome => {
    deps.onOutcome?.(outcome);
    return outcome;
  };

  let saved: WledUdpSinkConfig | undefined;
  try {
    saved = (await deps.loadShellState()).lastWledSink;
  } catch (err) {
    console.error("[LumaSync] WLED restore: shellStore.load() failed:", err);
    return emit({ kind: "no-saved-device" });
  }

  if (!saved) return emit({ kind: "no-saved-device" });
  emit({ kind: "restoring", sink: saved });

  let discovery: WledDiscoveryResponse;
  try {
    discovery = await deps.discover(saved.ip);
  } catch (err) {
    console.error("[LumaSync] WLED restore: discovery threw:", err);
    return emit({
      kind: "failed",
      sink: saved,
      status: {
        code: WLED_STATUS.DISCOVERY_UNREACHABLE,
        message: String(err),
      },
    });
  }

  const device = discovery.devices[0];
  if (discovery.status.code !== WLED_STATUS.DISCOVERY_OK || !device) {
    console.warn(
      `[LumaSync] WLED restore: ${saved.ip} did not answer (${discovery.status.code})`,
    );
    return emit({ kind: "failed", sink: saved, status: discovery.status });
  }

  const transport: WledTransportOverride = {
    port: saved.port,
    protocol: saved.protocol,
  };

  let connectResponse: WledConnectResponse;
  try {
    connectResponse = await deps.connect(device, transport);
  } catch (err) {
    console.error("[LumaSync] WLED restore: connect threw:", err);
    return emit({
      kind: "failed",
      sink: saved,
      status: {
        code: WLED_STATUS.BRIDGE_UNREACHABLE,
        message: String(err),
      },
    });
  }

  if (connectResponse.status.code !== WLED_STATUS.CONNECT_OK) {
    console.warn(
      `[LumaSync] WLED restore: connect rejected (${connectResponse.status.code})`,
    );
    return emit({ kind: "failed", sink: saved, status: connectResponse.status });
  }

  // The device owns the LED count, so re-trimming the strip in WLED heals
  // here instead of surfacing as a mismatch on every frame.
  const restored: WledUdpSinkConfig = { ...saved, ledCount: device.ledCount };
  if (restored.ledCount !== saved.ledCount) {
    try {
      await deps.saveShellState({ lastWledSink: restored });
    } catch (err) {
      console.error("[LumaSync] WLED restore: persisting refreshed sink failed:", err);
    }
  }

  return emit({ kind: "restored", sink: restored });
}
