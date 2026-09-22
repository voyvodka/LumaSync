//! Wire identity for the coded-status envelope.
//!
//! Four structs used to carry `{ code, message, details }`: `CommandStatus` in
//! `device_connection.rs` and in `hue_onboarding.rs`, `WledCommandStatus` and
//! `UpdaterCommandStatus`. They are now the one `commands::status::CommandStatus`.
//! Every expected string below was serialized from the old per-module struct
//! before the merge, so a derive or serde attribute that drifts on the shared
//! type — a `skip_serializing_if` on `details` above all — fails here for each
//! domain that used to own a copy.

use serde::Serialize;

use crate::commands::device_connection::{SerialConnectionStatus, SerialPortListResponse};
use crate::commands::hue_onboarding::{HueStreamReadiness, HueStreamReadinessResponse};
use crate::commands::lighting_mode::{
    LedTestPatternResult, LightingModeCommandResult, LightingModeConfig,
};
use crate::commands::room_map::hue_zone::HueZoneCommandResult;
use crate::commands::status::CommandStatus;
use crate::commands::updater::{UpdateCheckResponse, UpdateInstallResponse};
use crate::commands::wled_discovery::{WledConnectResponse, WledDiscoveryResponse};

/// Quotes, a non-ASCII dash and a newline, so escaping is part of the pin.
fn details() -> Option<String> {
    Some("port \"COM3\" — busy\n".to_string())
}

fn assert_wire<T: Serialize>(label: &str, value: &T, expected: &str) {
    let actual = serde_json::to_string(value).expect("status payload serializes");
    assert_eq!(actual, expected, "{label}: wire JSON changed");
}

#[test]
fn bare_status_sends_details_as_null_or_string_never_absent() {
    assert_wire(
        "no details",
        &CommandStatus::ok("CONNECT_OK", "Connected"),
        r#"{"code":"CONNECT_OK","message":"Connected","details":null}"#,
    );
    assert_wire(
        "with details",
        &CommandStatus::new("CONNECT_FAILED", "Failed", details()),
        r#"{"code":"CONNECT_FAILED","message":"Failed","details":"port \"COM3\" — busy\n"}"#,
    );
}

#[test]
fn serial_responses_are_unchanged() {
    assert_wire(
        "connect_serial_port",
        &SerialConnectionStatus {
            port_name: Some("COM3".into()),
            connected: false,
            status: CommandStatus::new("CONNECT_FAILED", "Failed", details()),
            updated_at_unix_ms: 1_700_000_000_000,
        },
        r#"{"portName":"COM3","connected":false,"status":{"code":"CONNECT_FAILED","message":"Failed","details":"port \"COM3\" — busy\n"},"updatedAtUnixMs":1700000000000}"#,
    );
    assert_wire(
        "list_serial_ports",
        &SerialPortListResponse {
            status: CommandStatus::ok("PORTS_LISTED", "ok"),
            ports: vec![],
        },
        r#"{"status":{"code":"PORTS_LISTED","message":"ok","details":null},"ports":[]}"#,
    );
}

#[test]
fn lighting_and_test_pattern_responses_are_unchanged() {
    assert_wire(
        "start_led_test_pattern",
        &LedTestPatternResult {
            active: true,
            preview_only: true,
            status: CommandStatus::ok("LED_TEST_PATTERN_PREVIEW_ONLY", "Preview only"),
        },
        r#"{"active":true,"previewOnly":true,"status":{"code":"LED_TEST_PATTERN_PREVIEW_ONLY","message":"Preview only","details":null}}"#,
    );
    assert_wire(
        "set_lighting_mode",
        &LightingModeCommandResult {
            active: false,
            mode: LightingModeConfig::default(),
            status: CommandStatus::new("LIGHTING_MODE_OFF", "Off", details()),
            wled_advisory: None,
        },
        r#"{"active":false,"mode":{"kind":"off","solid":null,"ambilight":null,"targets":null,"displayId":null,"ledCalibration":null,"colorCorrection":null,"firmwareProfile":null,"chipType":null},"status":{"code":"LIGHTING_MODE_OFF","message":"Off","details":"port \"COM3\" — busy\n"},"wledAdvisory":null}"#,
    );
}

#[test]
fn hue_responses_are_unchanged() {
    assert_wire(
        "check_hue_stream_readiness",
        &HueStreamReadinessResponse {
            status: CommandStatus::new("CONFIG_NOT_READY", "x", None),
            readiness: HueStreamReadiness {
                ready: false,
                reasons: vec!["r".into()],
            },
        },
        r#"{"status":{"code":"CONFIG_NOT_READY","message":"x","details":null},"readiness":{"ready":false,"reasons":["r"]}}"#,
    );
    assert_wire(
        "create_hue_zone",
        &HueZoneCommandResult {
            status: CommandStatus::new("HUE_ZONE_OK", "ok", details()),
            zones: vec![],
            channels: vec![],
        },
        r#"{"status":{"code":"HUE_ZONE_OK","message":"ok","details":"port \"COM3\" — busy\n"},"zones":[],"channels":[]}"#,
    );
}

#[test]
fn wled_responses_are_unchanged() {
    assert_wire(
        "discover_wled_devices",
        &WledDiscoveryResponse {
            status: CommandStatus::new("WLED_DISCOVERY_TIMEOUT", "t", details()),
            devices: vec![],
        },
        r#"{"status":{"code":"WLED_DISCOVERY_TIMEOUT","message":"t","details":"port \"COM3\" — busy\n"},"devices":[]}"#,
    );
    assert_wire(
        "connect_wled_sink",
        &WledConnectResponse {
            status: CommandStatus::ok("WLED_CONNECT_OK", "ok"),
        },
        r#"{"status":{"code":"WLED_CONNECT_OK","message":"ok","details":null}}"#,
    );
}

#[test]
fn updater_responses_are_unchanged() {
    assert_wire(
        "check_for_update",
        &UpdateCheckResponse {
            status: CommandStatus::new("UPDATE_CHECK_FAILED", "f", details()),
            channel: "beta".into(),
            update: None,
        },
        r#"{"status":{"code":"UPDATE_CHECK_FAILED","message":"f","details":"port \"COM3\" — busy\n"},"channel":"beta","update":null}"#,
    );
    assert_wire(
        "download_and_install_update",
        &UpdateInstallResponse {
            status: CommandStatus::ok("UPDATE_INSTALL_OK", "ok"),
        },
        r#"{"status":{"code":"UPDATE_INSTALL_OK","message":"ok","details":null}}"#,
    );
}

/// `HueZoneCommandResult` and `HueStreamReadinessResponse` derive `Deserialize`,
/// so the envelope must also read a payload that omits `details`.
#[test]
fn status_deserializes_with_details_absent_or_null() {
    let absent: CommandStatus =
        serde_json::from_str(r#"{"code":"X","message":"m"}"#).expect("absent details");
    let null: CommandStatus =
        serde_json::from_str(r#"{"code":"X","message":"m","details":null}"#).expect("null details");
    assert_eq!(absent, CommandStatus::ok("X", "m"));
    assert_eq!(null, absent);
}
