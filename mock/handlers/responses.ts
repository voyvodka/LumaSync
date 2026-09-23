/**
 * What each command must return, derived rather than restated.
 *
 * This file exists because the first fixture table was written by guessing
 * shapes from command names. Six of twelve Hue handlers returned something the
 * backend cannot produce, two status codes were invented outright, and the
 * telemetry handler returned a payload whose every field name was wrong — none
 * of which failed anywhere. It surfaced three screens away as an empty panel.
 *
 * Every entry below points at the type the real `*Api.ts` bridge already
 * declares, so a fixture with the wrong shape is a compile error in
 * `bun run typecheck:mock` rather than a blank panel. Where a response type
 * lives in a feature module rather than `src/shared/contracts/`, that is where
 * it is imported from: roughly half the surface is declared at the bridge
 * layer, and binding only to the contracts directory would type half the table
 * against the wrong thing while compiling clean.
 *
 * `import type` throughout — nothing here reaches the app at runtime.
 */

import type { DisplayInfo, DisplayOverlayCommandResult } from "../../src/shared/contracts/display";
import type {
  ScreenCapturePermissionResult,
  ScreenCaptureSettingsResult,
} from "../../src/shared/contracts/capture";
import type { WledSinkStatus } from "../../src/shared/contracts/device";
import type {
  HueAreaChannelListResponse,
  HueChannelWritebackStatus,
  HueCredentialMigrationResponse,
  HueOnboardingWireStatusCode,
  HueStatusCode,
} from "../../src/shared/contracts/hue";
import type { CommandStatusOf } from "../../src/shared/contracts/status";
import type {
  ControlPopupResult,
  LedPreviewStatus,
  LedTestPatternResult,
  TwinOverlayResult,
} from "../../src/shared/contracts/preview";
import type {
  UpdateCheckResponse,
  UpdateInstallResponse,
} from "../../src/shared/contracts/updater";
import type { FullTelemetrySnapshot } from "../../src/shared/contracts/telemetry";

import type {
  HealthCheckResult,
  SerialConnectionStatus,
  SerialPortListResponse,
} from "../../src/features/device/deviceConnectionApi";
import type {
  WledConnectResponse,
  WledDiscoveryResponse,
  WledTestResponse,
} from "../../src/features/device/wledApi";
import type {
  HueDiscoveryResponse,
  HueEntertainmentAreaListResponse,
  HuePairBridgeResponse,
  HueStreamReadinessResponse,
  HueVerifyBridgeIpResponse,
} from "../../src/features/hue/hueOnboardingApi";
import type {
  HueRuntimeCommandResult,
  ModeCommandResult,
} from "../../src/features/mode/modeApi";

/**
 * `validate_hue_credentials`'s own status codes, narrowed out of the shared
 * `HueOnboardingWireStatusCode` union that `HueValidateCredentialsResponse`
 * is typed against. That union covers all six onboarding commands at once —
 * discover, verify, pair, validate, list-areas, check-readiness — so a
 * fixture returning `HUE_IP_VALID` (verify's code) here instead of
 * `HUE_CREDENTIAL_VALID` (this command's) still satisfied the wide type and
 * passed `typecheck:mock` clean. Only this entry is narrowed, not the shared
 * contract type: the other five onboarding fixtures have pre-existing code
 * choices of their own that narrowing here does not touch.
 */
type ValidateHueCredentialsCode = Extract<
  HueOnboardingWireStatusCode,
  | "HUE_IP_INVALID"
  | "HUE_CREDENTIAL_VALID"
  | "HUE_CREDENTIAL_INVALID"
  | "HUE_CREDENTIAL_CHECK_FAILED"
  | "HUE_BRIDGE_IDENTITY_MISMATCH"
>;

type ValidateHueCredentialsMockResponse = {
  status: CommandStatusOf<ValidateHueCredentialsCode>;
  valid: boolean;
};

/**
 * The remaining five onboarding commands' own status codes, narrowed the same
 * way `ValidateHueCredentialsCode` above narrows `validate_hue_credentials`'s
 * — each `Extract` is read off the real Rust handler in
 * `src-tauri/src/commands/hue_onboarding.rs`, not off what the fixture
 * happened to return. Narrowing these caught three drifted codes: `pair`
 * answered with the frontend-minted `HUE_PAIRING_PENDING_LINK_BUTTON`
 * instead of the wire's `HUE_PAIRING_LINK_BUTTON_NOT_PRESSED`; `list-areas`
 * answered unreachable with `HUE_IP_UNREACHABLE` (`verify_hue_bridge_ip`'s
 * own code) instead of `HUE_AREA_LIST_FAILED`, and success with
 * `HUE_DISCOVERY_OK` instead of `HUE_AREA_LIST_OK`; `check-readiness`
 * answered entirely in `verify_hue_bridge_ip`'s `HUE_IP_VALID` /
 * `HUE_IP_UNREACHABLE` terms instead of its own
 * `HUE_STREAM_READY` / `HUE_STREAM_NOT_READY` / `HUE_STREAM_READINESS_FAILED`.
 */
type DiscoverHueBridgesCode = Extract<
  HueOnboardingWireStatusCode,
  "HUE_DISCOVERY_OK" | "HUE_DISCOVERY_EMPTY" | "HUE_DISCOVERY_FAILED"
>;

type DiscoverHueBridgesMockResponse = {
  status: CommandStatusOf<DiscoverHueBridgesCode>;
  bridges: HueDiscoveryResponse["bridges"];
};

type VerifyHueBridgeIpCode = Extract<
  HueOnboardingWireStatusCode,
  "HUE_IP_INVALID" | "HUE_IP_UNREACHABLE" | "HUE_IP_VALID" | "HUE_BRIDGE_IDENTITY_MISMATCH"
>;

type VerifyHueBridgeIpMockResponse = {
  status: CommandStatusOf<VerifyHueBridgeIpCode>;
  bridge: HueVerifyBridgeIpResponse["bridge"];
};

// `pair_hue_bridge`'s declared status type (`HuePairBridgeResponse.status`)
// is `HueCommandStatus = CommandStatusOf<HueStatusCode>`, not the
// `HueOnboardingWireStatusCode` the other four share — pairing never emits
// `AUTH_INVALID_RE_PAIR_REQUIRED` (there are no credentials yet to reject),
// so it narrows off the plain `HueStatusCode` union instead.
type PairHueBridgeCode = Extract<
  HueStatusCode,
  | "HUE_IP_INVALID"
  | "HUE_PAIRING_OK"
  | "HUE_PAIRING_LINK_BUTTON_NOT_PRESSED"
  | "HUE_PAIRING_DEVICETYPE_INVALID"
  | "HUE_PAIRING_BRIDGE_BUSY"
  | "HUE_PAIRING_RATE_LIMITED"
  | "HUE_PAIRING_FAILED"
  | "HUE_BRIDGE_IDENTITY_MISMATCH"
>;

type PairHueBridgeMockResponse = {
  status: CommandStatusOf<PairHueBridgeCode>;
  credentials: HuePairBridgeResponse["credentials"];
  credentialStorageBackend?: HuePairBridgeResponse["credentialStorageBackend"];
};

type ListHueEntertainmentAreasCode = Extract<
  HueOnboardingWireStatusCode,
  | "HUE_IP_INVALID"
  | "AUTH_INVALID_RE_PAIR_REQUIRED"
  | "HUE_AREA_LIST_OK"
  | "HUE_AREA_LIST_EMPTY"
  | "HUE_AREA_LIST_FAILED"
>;

type ListHueEntertainmentAreasMockResponse = {
  status: CommandStatusOf<ListHueEntertainmentAreasCode>;
  areas: HueEntertainmentAreaListResponse["areas"];
};

type CheckHueStreamReadinessCode = Extract<
  HueOnboardingWireStatusCode,
  | "HUE_IP_INVALID"
  | "AUTH_INVALID_RE_PAIR_REQUIRED"
  | "HUE_STREAM_READY"
  | "HUE_STREAM_NOT_READY"
  | "HUE_STREAM_READINESS_FAILED"
>;

type CheckHueStreamReadinessMockResponse = {
  status: CommandStatusOf<CheckHueStreamReadinessCode>;
  readiness: HueStreamReadinessResponse["readiness"];
};

/**
 * The response each mocked command must produce.
 *
 * Keys are the command names as literals rather than computed from the
 * `*COMMANDS` maps, because TypeScript will not take a computed literal as an
 * index signature. The drift that spelling would have caught is caught instead
 * by `NoUnknownResponseKey` in `index.ts`, which fails when a key here is not
 * a command the contracts declare.
 */
export interface CommandResponse {
  // --- serial ---------------------------------------------------------------
  list_serial_ports: SerialPortListResponse;
  connect_serial_port: SerialConnectionStatus;
  get_serial_connection_status: SerialConnectionStatus;
  run_serial_health_check: HealthCheckResult;

  // --- wled -----------------------------------------------------------------
  discover_wled_devices: WledDiscoveryResponse;
  connect_wled_sink: WledConnectResponse;
  test_wled_bridge: WledTestResponse;
  get_wled_sink_status: WledSinkStatus;

  // --- lighting -------------------------------------------------------------
  set_lighting_mode: ModeCommandResult;
  stop_lighting: ModeCommandResult;
  get_lighting_mode_status: ModeCommandResult;

  /**
   * The one command whose bridge return type is NOT the wire type —
   * `telemetryApi.ts` maps a DTO on the way through and does not export it — so
   * the contract type is the honest binding here.
   */
  get_runtime_telemetry: FullTelemetrySnapshot;

  // --- hue ------------------------------------------------------------------
  discover_hue_bridges: DiscoverHueBridgesMockResponse;
  verify_hue_bridge_ip: VerifyHueBridgeIpMockResponse;
  pair_hue_bridge: PairHueBridgeMockResponse;
  start_hue_stream: HueRuntimeCommandResult;
  stop_hue_stream: HueRuntimeCommandResult;
  restart_hue_stream: HueRuntimeCommandResult;
  get_hue_stream_status: HueRuntimeCommandResult;
  set_hue_solid_color: HueRuntimeCommandResult;
  validate_hue_credentials: ValidateHueCredentialsMockResponse;
  list_hue_entertainment_areas: ListHueEntertainmentAreasMockResponse;
  check_hue_stream_readiness: CheckHueStreamReadinessMockResponse;
  update_hue_channel_positions: HueChannelWritebackStatus;
  get_hue_area_channels: HueAreaChannelListResponse;
  migrate_hue_credentials: HueCredentialMigrationResponse;

  // --- shell ----------------------------------------------------------------
  list_displays: DisplayInfo[];
  get_screen_capture_permission: ScreenCapturePermissionResult;
  open_screen_capture_settings: ScreenCaptureSettingsResult;
  open_led_twin_overlay: TwinOverlayResult;
  close_led_twin_overlay: TwinOverlayResult;
  start_led_test_pattern: LedTestPatternResult;
  stop_led_test_pattern: LedTestPatternResult;
  check_for_update: UpdateCheckResponse;
  download_and_install_update: UpdateInstallResponse;

  // --- windowless -----------------------------------------------------------
  // Answered even though the effect needs a second webview or an OS surface;
  // see `windowless.ts` for why leaving them unanswered was a defect.
  open_led_control_popup: ControlPopupResult;
  show_led_control_popup: ControlPopupResult;
  hide_led_control_popup: ControlPopupResult;
  get_led_preview_status: LedPreviewStatus;
  open_display_overlay: DisplayOverlayCommandResult;
  close_display_overlay: DisplayOverlayCommandResult;
  update_display_overlay_preview: DisplayOverlayCommandResult;
  show_notification: null;
  request_notification_permission: string;
  open_log_dir: null;
  update_tray_labels: null;
}

/** A command this table types. */
export type TypedCommandName = keyof CommandResponse & string;
