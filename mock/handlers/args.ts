/**
 * What each command must be *called* with — the mirror of `responses.ts`,
 * for the other half of the wire.
 *
 * `responses.ts` exists because a handler can return the wrong shape and
 * nothing catches it until a panel renders empty three screens away. This
 * file exists because a handler can read the wrong shape on the way *in* and
 * nothing catches that either: `set_lighting_mode`'s fixture read `args.mode`
 * for the whole life of this mock while `modeApi.ts` has only ever sent
 * `{ payload }`, so the mock silently applied every mode as "off" and Solid
 * mode could never be reached through it. The command-name exhaustiveness
 * guard in `index.ts` cannot see this class of bug — it only proves a
 * handler exists, never that it reads what the bridge actually sends.
 *
 * Every entry below is built from the same types the matching `*Api.ts`
 * function uses to construct its `invoke()` payload, so a handler destructuring
 * a field these types don't have fails `bun run typecheck:mock`.
 *
 * Only commands whose real payload is non-empty are declared here — a
 * zero-arg command has nothing for this file to protect. `types.ts` falls
 * back to the old untyped `Record<string, unknown> | undefined` for anything
 * not listed, which today is every zero-arg command in device/mode/hue
 * (`list_serial_ports`, `get_serial_connection_status`, `discover_hue_bridges`,
 * `get_hue_stream_status`, `stop_lighting`, `get_lighting_mode_status`,
 * `get_runtime_telemetry`, …) plus the whole `shell.ts` / `windowless.ts`
 * surface (window/tray/notification/preview commands, `list_displays`,
 * updater, plugin passthroughs) and the room-map / capture / platform /
 * updater command families — none of those are in scope here.
 *
 * `import type` throughout — nothing here reaches the app at runtime.
 */

import type { LedChipType, WledDeviceInfo, WledProtocol } from "../../src/shared/contracts/device";
import type {
  HueChannelPlacementOverride,
  HueRuntimeTriggerSource,
} from "../../src/shared/contracts/hue";
import type { HueChannelPlacement } from "../../src/shared/contracts/roomMap";
import type { LightingModeConfig } from "../../src/features/mode/model/contracts";

/**
 * Shared by `start_hue_stream` / `restart_hue_stream` — `startHue` and
 * `restartHue` in `modeApi.ts` build the identical envelope for both.
 */
interface HueStreamStartArgs {
  request: {
    bridgeIp: string;
    username: string;
    clientKey: string;
    areaId: string;
    triggerSource: HueRuntimeTriggerSource;
    channelPlacements?: HueChannelPlacementOverride[];
  };
}

export interface CommandArgs {
  // --- device: serial ---------------------------------------------------
  connect_serial_port: { portName: string; chipType: LedChipType | null };
  run_serial_health_check: { portName: string };

  // --- device: wled -------------------------------------------------------
  discover_wled_devices: { request: { ip: string } };
  connect_wled_sink: {
    request: { device: WledDeviceInfo; port?: number; protocol?: WledProtocol };
  };
  test_wled_bridge: { request: { device: WledDeviceInfo } };

  // --- device: lighting mode -----------------------------------------------
  /** `setLightingMode` in `modeApi.ts` sends `{ payload }`, never `{ mode }`. */
  set_lighting_mode: { payload: LightingModeConfig };

  // --- hue: onboarding ------------------------------------------------------
  verify_hue_bridge_ip: { bridgeIp: string };
  pair_hue_bridge: { bridgeIp: string };
  migrate_hue_credentials: { username: string; clientKey: string };
  validate_hue_credentials: { bridgeIp: string; username: string; clientKey?: string };
  list_hue_entertainment_areas: { bridgeIp: string; username: string };
  check_hue_stream_readiness: { bridgeIp: string; username: string; areaId: string };
  get_hue_area_channels: { bridgeIp: string; username: string; areaId: string };

  // --- hue: runtime -----------------------------------------------------------
  start_hue_stream: HueStreamStartArgs;
  restart_hue_stream: HueStreamStartArgs;
  stop_hue_stream: { triggerSource: HueRuntimeTriggerSource };
  set_hue_solid_color: {
    request: {
      r: number;
      g: number;
      b: number;
      brightness?: number;
      triggerSource: HueRuntimeTriggerSource;
    };
  };
  update_hue_channel_positions: {
    channels: HueChannelPlacement[];
    bridgeIp: string;
    username: string;
    areaId: string;
  };
}

/** A command this table types. */
export type TypedCommandName = keyof CommandArgs & string;
