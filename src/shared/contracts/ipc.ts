/**
 * The IPC command map: for every Tauri command the contracts declare, what it
 * is called with and what it resolves to. The one table `invokeCommand`, the
 * dev mock and the test helpers are all typed from — so a command name typo,
 * a payload key the handler never reads, or a fixture of the wrong shape is a
 * compile error instead of an empty panel.
 *
 * `args` is the object handed to `invoke()`: its top-level keys are the Rust
 * handler's parameter names (Tauri matches them by name, camelCased). `never`
 * marks a command that takes none. `result` is the resolved value; a command
 * that rejects does so with `Err(String)`, read by `parseCommandError`.
 *
 * Keys are spelled as literals rather than computed from the `*_COMMANDS` maps
 * so this module stays type-only. The guards at the bottom close the loop in
 * both directions against those maps, which `verify:shell-contracts` in turn
 * pins against `generate_handler!`.
 *
 * Type-only on purpose: `scripts/verify/window-grants.mjs` reads every
 * `*_COMMANDS.X` a window's live code references, and a runtime import of this
 * table would make every window look like it invokes every command.
 */

import type {
  CAPTURE_COMMANDS,
  ScreenCapturePermissionResult,
  ScreenCaptureSettingsResult,
} from "./capture";
import type {
  DEVICE_COMMANDS,
  HealthCheckResult,
  LedChipType,
  SerialConnectionStatus,
  SerialPortListResponse,
  WledConnectResponse,
  WledDeviceInfo,
  WledForgetResponse,
  WledDiscoveryResponse,
  WledProtocol,
  WledSinkStatus,
  WledTestResponse,
} from "./device";
import type {
  DISPLAY_OVERLAY_COMMANDS,
  DisplayId,
  DisplayInfo,
  DisplayOverlayCommandResult,
  OverlayPreviewPayload,
} from "./display";
import type {
  HUE_COMMANDS,
  HUE_DEBUG_COMMANDS,
  HueAreaChannelListResponse,
  HueChannelWritebackStatus,
  HueCredentialMigrationResponse,
  HueDebugCommandCode,
  HueDiscoveryResponse,
  HueEntertainmentAreaListResponse,
  HueForgetStatus,
  HueIdentifyStatus,
  HueLightNamesResponse,
  HuePairBridgeResponse,
  HueRuntimeCommandResult,
  HueRuntimeTriggerSource,
  HueStreamReadinessResponse,
  HueValidateCredentialsResponse,
  HueVerifyBridgeIpResponse,
  SetHueSolidColorRequest,
  StartHueStreamRequest,
} from "./hue";
import type { HUE_HEALTH_COMMANDS, HueHealthSnapshot, HueHealthWatch } from "./hueHealth";
import type {
  ApplyOutputsRequest,
  ApplyOutputsResult,
  LIGHTING_RUNTIME_COMMANDS,
  LightingRuntimeSnapshot,
  LightingTuning,
  ReleaseHueTrigger,
  RetuneLightingResult,
} from "./lightingRuntime";
import type { LightingModeCommandResult, LightingModeConfig } from "./mode";
import type { NotificationPayload, NotificationResult, PLATFORM_COMMANDS } from "./platform";
import type {
  CloseLedTwinOverlayPayload,
  ControlPopupResult,
  LedPreviewStatus,
  LedTestPatternResult,
  OpenLedTwinOverlayPayload,
  PREVIEW_COMMANDS,
  StartLedTestPatternPayload,
  TwinOverlayResult,
} from "./preview";
import type {
  AssignChannelRequest,
  CreateHueZoneRequest,
  DeleteHueZoneRequest,
  HUE_ZONE_COMMANDS,
  HueChannelPlacement,
  HueZoneCommandResult,
  ROOM_MAP_COMMANDS,
  UpdateHueZoneRequest,
} from "./roomMap";
import type {
  LaunchContext,
  MainWindowVisibility,
  SHELL_COMMANDS,
  ShellStatePatchRequest,
  ShellStateReplaceRequest,
  ShellStateSnapshot,
  ShellStateWriteResult,
  TrayLabels,
} from "./shell";
import type { CommandStatusOf } from "./status";
import type { FullTelemetrySnapshot } from "./telemetry";
import type { UPDATER_COMMANDS, UpdateCheckResponse, UpdateInstallResponse } from "./updater";

interface Command<TArgs, TResult> {
  args: TArgs;
  result: TResult;
}

/** A command whose Rust handler takes no frontend argument. */
type NoArgs<TResult> = Command<never, TResult>;

/** The flat credential triple most Hue bridge reads take. */
interface HueAreaArgs {
  bridgeIp: string;
  username: string;
  areaId: string;
}

export interface CommandMap {
  // --- capture ------------------------------------------------------------
  get_screen_capture_permission: NoArgs<ScreenCapturePermissionResult>;
  open_screen_capture_settings: NoArgs<ScreenCaptureSettingsResult>;

  // --- device: serial -----------------------------------------------------
  list_serial_ports: NoArgs<SerialPortListResponse>;
  connect_serial_port: Command<{ portName: string; chipType: LedChipType | null }, SerialConnectionStatus>;
  get_serial_connection_status: NoArgs<SerialConnectionStatus>;
  run_serial_health_check: Command<{ portName: string }, HealthCheckResult>;

  // --- device: lighting mode (the lighting transaction supersedes these) ---
  set_lighting_mode: Command<{ payload: LightingModeConfig }, LightingModeCommandResult>;
  stop_lighting: NoArgs<LightingModeCommandResult>;
  get_lighting_mode_status: NoArgs<LightingModeCommandResult>;
  /** The wire DTO; `telemetryApi` normalises it on the way through. */
  get_runtime_telemetry: NoArgs<FullTelemetrySnapshot>;

  // --- device: WLED (every handler takes one struct named `request`) -------
  discover_wled_devices: Command<{ request: { ip: string } }, WledDiscoveryResponse>;
  connect_wled_sink: Command<
    { request: { device: WledDeviceInfo; port?: number; protocol?: WledProtocol } },
    WledConnectResponse
  >;
  test_wled_bridge: Command<{ request: { device: WledDeviceInfo } }, WledTestResponse>;
  get_wled_sink_status: NoArgs<WledSinkStatus>;
  forget_wled_device: Command<{ request: { ip: string } }, WledForgetResponse>;

  // --- display overlay ----------------------------------------------------
  list_displays: NoArgs<DisplayInfo[]>;
  open_display_overlay: Command<
    { displayId: DisplayId; preview?: OverlayPreviewPayload },
    DisplayOverlayCommandResult
  >;
  close_display_overlay: Command<{ displayId: DisplayId }, DisplayOverlayCommandResult>;
  update_display_overlay_preview: Command<{ preview: OverlayPreviewPayload }, DisplayOverlayCommandResult>;

  // --- hue: onboarding ----------------------------------------------------
  discover_hue_bridges: NoArgs<HueDiscoveryResponse>;
  verify_hue_bridge_ip: Command<{ bridgeIp: string }, HueVerifyBridgeIpResponse>;
  pair_hue_bridge: Command<{ bridgeIp: string }, HuePairBridgeResponse>;
  validate_hue_credentials: Command<
    { bridgeIp: string; username: string; clientKey?: string },
    HueValidateCredentialsResponse
  >;
  list_hue_entertainment_areas: Command<
    { bridgeIp: string; username: string },
    HueEntertainmentAreaListResponse
  >;
  check_hue_stream_readiness: Command<HueAreaArgs, HueStreamReadinessResponse>;
  get_hue_area_channels: Command<HueAreaArgs, HueAreaChannelListResponse>;
  migrate_hue_credentials: Command<{ username: string; clientKey: string }, HueCredentialMigrationResponse>;
  forget_hue_bridge: Command<{ bridgeId: string }, HueForgetStatus>;
  get_hue_light_names: Command<
    { bridgeIp: string; username: string; lightIds: string[] },
    HueLightNamesResponse
  >;
  identify_hue_lights: Command<
    { bridgeIp: string; username: string; lightIds: string[] },
    HueIdentifyStatus
  >;

  // --- hue: runtime -------------------------------------------------------
  start_hue_stream: Command<{ request: StartHueStreamRequest }, HueRuntimeCommandResult>;
  restart_hue_stream: Command<{ request: StartHueStreamRequest }, HueRuntimeCommandResult>;
  stop_hue_stream: Command<{ triggerSource?: HueRuntimeTriggerSource }, HueRuntimeCommandResult>;
  set_hue_solid_color: Command<{ request: SetHueSolidColorRequest }, HueRuntimeCommandResult>;
  get_hue_stream_status: NoArgs<HueRuntimeCommandResult>;
  /** Flat args — `save_load.rs` takes four positional params, not an envelope. */
  update_hue_channel_positions: Command<
    HueAreaArgs & { channels: HueChannelPlacement[] },
    HueChannelWritebackStatus
  >;
  /** Debug builds only; never invoked from `src/`. */
  simulate_hue_fault: NoArgs<CommandStatusOf<HueDebugCommandCode>>;

  // --- hue: health monitor ------------------------------------------------
  get_hue_health: NoArgs<HueHealthSnapshot>;
  watch_hue_health: Command<{ watch: HueHealthWatch }, HueHealthSnapshot>;
  retry_hue_health: NoArgs<HueHealthSnapshot>;

  // --- hue: zone authoring (room map) -------------------------------------
  create_hue_zone: Command<{ request: CreateHueZoneRequest }, HueZoneCommandResult>;
  update_hue_zone: Command<{ request: UpdateHueZoneRequest }, HueZoneCommandResult>;
  delete_hue_zone: Command<{ request: DeleteHueZoneRequest }, HueZoneCommandResult>;
  assign_channel_to_hue_zone: Command<{ request: AssignChannelRequest }, HueZoneCommandResult>;
  /** Resolves to the destination path. */
  copy_background_image: Command<{ srcPath: string }, string>;

  // --- lighting transaction -----------------------------------------------
  apply_outputs: Command<{ request: ApplyOutputsRequest }, ApplyOutputsResult>;
  retune_lighting: Command<{ tuning: LightingTuning }, RetuneLightingResult>;
  release_hue_output: Command<{ triggerSource: ReleaseHueTrigger }, ApplyOutputsResult>;
  get_lighting_runtime: NoArgs<LightingRuntimeSnapshot>;

  // --- platform -----------------------------------------------------------
  show_notification: Command<{ payload: NotificationPayload }, NotificationResult>;
  request_notification_permission: NoArgs<NotificationResult>;
  open_log_dir: NoArgs<null>;

  // --- preview ------------------------------------------------------------
  start_led_test_pattern: Command<{ payload: StartLedTestPatternPayload }, LedTestPatternResult>;
  stop_led_test_pattern: NoArgs<LedTestPatternResult>;
  get_led_preview_status: NoArgs<LedPreviewStatus>;
  open_led_twin_overlay: Command<{ payload: OpenLedTwinOverlayPayload }, TwinOverlayResult>;
  /** `payload` is required even when empty: Rust's argument is not optional. */
  close_led_twin_overlay: Command<{ payload: CloseLedTwinOverlayPayload }, TwinOverlayResult>;
  open_led_control_popup: NoArgs<ControlPopupResult>;
  show_led_control_popup: NoArgs<ControlPopupResult>;
  hide_led_control_popup: NoArgs<ControlPopupResult>;

  // --- shell --------------------------------------------------------------
  update_tray_labels: Command<{ labels: TrayLabels }, null>;
  get_launch_context: NoArgs<LaunchContext>;
  get_main_window_visibility: NoArgs<MainWindowVisibility>;
  get_shell_state: NoArgs<ShellStateSnapshot>;
  patch_shell_state: Command<{ patch: ShellStatePatchRequest }, ShellStateWriteResult>;
  replace_shell_state: Command<{ request: ShellStateReplaceRequest }, ShellStateWriteResult>;

  // --- updater ------------------------------------------------------------
  check_for_update: NoArgs<UpdateCheckResponse>;
  download_and_install_update: NoArgs<UpdateInstallResponse>;
}

/** Every command the map types. Equal to {@link ContractCommandName}, both ways. */
export type CommandName = keyof CommandMap;

/** The object `invoke()` sends, or `never` for a command that takes none. */
export type CommandArgs<K extends CommandName> = CommandMap[K]["args"];

/** What the command resolves to. */
export type CommandResult<K extends CommandName> = CommandMap[K]["result"];

/** `invokeCommand`'s argument list after the name: nothing for a no-arg
 * command, exactly one args object otherwise. */
export type CommandArgsTuple<K extends CommandName> = [CommandArgs<K>] extends [never]
  ? []
  : [args: CommandArgs<K>];

/** The typed `invoke()`. The one injectable transport every `*Api.ts` bridge
 * takes, so a test's mock is checked against the same table. */
export type CommandInvoker = <K extends CommandName>(
  command: K,
  ...args: CommandArgsTuple<K>
) => Promise<CommandResult<K>>;

// ---------------------------------------------------------------------------
// The guard — the map covers exactly the declared commands.
// ---------------------------------------------------------------------------

type ValuesOf<T> = T[keyof T];

/** Every command name the `*_COMMANDS` maps declare. */
export type ContractCommandName =
  | ValuesOf<typeof CAPTURE_COMMANDS>
  | ValuesOf<typeof DEVICE_COMMANDS>
  | ValuesOf<typeof DISPLAY_OVERLAY_COMMANDS>
  | ValuesOf<typeof HUE_COMMANDS>
  | ValuesOf<typeof HUE_DEBUG_COMMANDS>
  | ValuesOf<typeof HUE_HEALTH_COMMANDS>
  | ValuesOf<typeof HUE_ZONE_COMMANDS>
  | ValuesOf<typeof LIGHTING_RUNTIME_COMMANDS>
  | ValuesOf<typeof PLATFORM_COMMANDS>
  | ValuesOf<typeof PREVIEW_COMMANDS>
  | ValuesOf<typeof ROOM_MAP_COMMANDS>
  | ValuesOf<typeof SHELL_COMMANDS>
  | ValuesOf<typeof UPDATER_COMMANDS>;

type ExpectNone<T extends never> = T;

// If either line errors, the literal it names is the command to add or remove.
// Exported only so `noUnusedLocals` keeps them; nothing imports them.
export type EveryContractCommandIsMapped = ExpectNone<Exclude<ContractCommandName, CommandName>>;
export type EveryMappedCommandIsDeclared = ExpectNone<Exclude<CommandName, ContractCommandName>>;
