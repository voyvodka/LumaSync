use std::net::Ipv4Addr;

use serde_json::json;

use super::strip_set::{
    resolve_strips, strips_from, DrivenStrip, LeftOutReason, LeftOutStrip, StripSet,
};
use crate::commands::device_connection::{command_status, SerialConnectionStatus};
use crate::commands::local_outputs::{DrivenLocal, LocalOutputRegistry};
use crate::commands::shell_state::PersistedShellState;
use crate::commands::wled_sink::{WledProtocol, WledSinkConfig};
use crate::models::led_strips::{LedStrip, StripHardware, StripTransport};

fn serial(port: &str) -> DrivenLocal {
    DrivenLocal::Serial(port.to_string())
}

fn wled_config(last_octet: u8, port: u16, led_count: u16) -> WledSinkConfig {
    WledSinkConfig {
        ip: Ipv4Addr::new(192, 168, 1, last_octet),
        port,
        led_count,
        protocol: WledProtocol::Ddp,
    }
}

fn saved(id: &str, transport: Option<StripTransport>, enabled: bool) -> LedStrip {
    LedStrip {
        id: id.to_string(),
        name: None,
        enabled,
        transport,
        hardware: StripHardware::default(),
        layout: None,
        color_correction: None,
    }
}

fn on_port(id: &str, port: &str) -> LedStrip {
    saved(
        id,
        Some(StripTransport::Serial {
            port_name: port.to_string(),
        }),
        true,
    )
}

fn driven(output: DrivenLocal, strip_id: Option<&str>) -> DrivenStrip {
    DrivenStrip {
        output,
        strip_id: strip_id.map(str::to_string),
    }
}

fn left_out(strip_id: &str, reason: LeftOutReason) -> LeftOutStrip {
    LeftOutStrip {
        strip_id: strip_id.to_string(),
        reason,
    }
}

#[test]
fn a_connected_port_no_saved_strip_names_is_driven_all_the_same() {
    let set = resolve_strips(&[], vec![serial("COM3")]);
    assert_eq!(set.driven, vec![driven(serial("COM3"), None)]);
    assert!(set.left_out.is_empty());
    assert_eq!(set.primary(), Some(&serial("COM3")));
}

#[test]
fn a_connected_port_is_matched_to_its_saved_strip() {
    let set = resolve_strips(&[on_port("strip-1", "COM3")], vec![serial("COM3")]);
    assert_eq!(set.driven, vec![driven(serial("COM3"), Some("strip-1"))]);
    assert!(set.left_out.is_empty());
}

#[test]
fn a_saved_strip_whose_port_is_not_connected_is_left_out() {
    let set = resolve_strips(
        &[on_port("strip-1", "COM3"), on_port("strip-2", "COM4")],
        vec![serial("COM4")],
    );
    assert_eq!(set.driven, vec![driven(serial("COM4"), Some("strip-2"))]);
    assert_eq!(
        set.left_out,
        vec![left_out("strip-1", LeftOutReason::NotConnected)]
    );
}

#[test]
fn the_connect_order_decides_what_comes_first_not_the_saved_order() {
    let set = resolve_strips(
        &[on_port("strip-1", "COM3"), on_port("strip-2", "COM4")],
        vec![serial("COM4"), serial("COM3")],
    );
    assert_eq!(
        set.driven,
        vec![
            driven(serial("COM4"), Some("strip-2")),
            driven(serial("COM3"), Some("strip-1")),
        ]
    );
    assert_eq!(set.primary(), Some(&serial("COM4")));
}

#[test]
fn a_wled_device_is_matched_by_its_address_whatever_its_saved_port_or_led_count() {
    let wled = saved(
        "strip-2",
        Some(StripTransport::Wled {
            sink: json!({ "ip": "192.168.1.42", "port": 21324, "ledCount": 60, "protocol": "drgb" }),
        }),
        true,
    );
    let live = DrivenLocal::Wled(wled_config(42, 4048, 120));
    let set = resolve_strips(std::slice::from_ref(&wled), vec![live.clone()]);
    assert_eq!(set.driven, vec![driven(live, Some("strip-2"))]);

    let other = resolve_strips(&[wled], vec![DrivenLocal::Wled(wled_config(43, 21324, 60))]);
    assert_eq!(other.driven[0].strip_id, None);
    assert_eq!(
        other.left_out,
        vec![left_out("strip-2", LeftOutReason::NotConnected)]
    );
}

#[test]
fn a_second_saved_strip_on_a_taken_port_is_left_out_as_a_duplicate() {
    let set = resolve_strips(
        &[on_port("first", "COM3"), on_port("second", "COM3")],
        vec![serial("COM3")],
    );
    assert_eq!(set.driven, vec![driven(serial("COM3"), Some("first"))]);
    assert_eq!(
        set.left_out,
        vec![left_out("second", LeftOutReason::DuplicateTransport)]
    );
}

#[test]
fn enabled_does_not_decide_anything_until_the_worker_fans_out() {
    let set = resolve_strips(
        &[saved(
            "strip-1",
            Some(StripTransport::Serial {
                port_name: "COM3".into(),
            }),
            false,
        )],
        vec![serial("COM3")],
    );
    assert_eq!(set.driven, vec![driven(serial("COM3"), Some("strip-1"))]);
}

#[test]
fn a_saved_strip_that_names_no_port_or_device_is_left_out() {
    let set = resolve_strips(&[saved("strip-1", None, true)], vec![]);
    assert!(set.driven.is_empty());
    assert_eq!(
        set.left_out,
        vec![left_out("strip-1", LeftOutReason::NotConnected)]
    );
}

#[test]
fn the_primary_gives_the_mode_apply_its_three_channel_arguments() {
    assert_eq!(StripSet::default().plan_args(), (false, None, None));
    assert_eq!(
        resolve_strips(&[], vec![serial("COM3")]).plan_args(),
        (true, Some("COM3"), None)
    );
    let config = wled_config(42, 4048, 120);
    assert_eq!(
        resolve_strips(&[], vec![DrivenLocal::Wled(config), serial("COM3")]).plan_args(),
        (false, None, Some(config))
    );
}

fn connect(registry: &LocalOutputRegistry, port: &str) {
    registry.serial_connected(SerialConnectionStatus {
        port_name: Some(port.to_string()),
        connected: true,
        status: command_status("CONNECT_OK", "ok", None),
        updated_at_unix_ms: 5,
        firmware: None,
    });
}

#[test]
fn the_registry_lists_every_connected_output_earliest_first_and_drives_the_first() {
    let registry = LocalOutputRegistry::default();
    connect(&registry, "COM4");
    registry.wled_bound(wled_config(42, 4048, 120));
    connect(&registry, "COM3");
    // Connected again, a port keeps its place.
    connect(&registry, "COM4");

    assert_eq!(
        registry.connected_outputs(),
        vec![
            serial("COM4"),
            DrivenLocal::Wled(wled_config(42, 4048, 120)),
            serial("COM3")
        ]
    );
    assert_eq!(registry.driven(), Some(serial("COM4")));
}

// The guard for 3b-1: only a connected output is driven. A port that failed to connect, or was
// unplugged, keeps its entry for the Devices page but must not be planned for.
#[test]
fn a_port_that_is_not_connected_is_not_driven_and_its_strip_is_left_out() {
    let registry = LocalOutputRegistry::default();
    connect(&registry, "COM3");
    registry.serial_failed(
        Some("COM5"),
        SerialConnectionStatus {
            port_name: Some("COM5".to_string()),
            connected: false,
            status: command_status("PORT_BUSY", "busy", None),
            updated_at_unix_ms: 6,
            firmware: None,
        },
    );
    registry
        .serial_lost("COM3", u128::MAX)
        .expect("the connected port goes away");

    assert!(registry.connected_outputs().is_empty());
    let set = resolve_strips(
        &[on_port("strip-1", "COM3"), on_port("strip-5", "COM5")],
        registry.connected_outputs(),
    );
    assert!(set.driven.is_empty());
    assert_eq!(
        set.left_out,
        vec![
            left_out("strip-1", LeftOutReason::NotConnected),
            left_out("strip-5", LeftOutReason::NotConnected),
        ]
    );
}

#[test]
fn the_strips_an_apply_plans_with_read_the_saved_file_and_refuse_a_poisoned_registry() {
    let registry = LocalOutputRegistry::default();
    connect(&registry, "COM3");
    let persisted = PersistedShellState::from_file_json(
        &json!({ "shell-state": { "ledStrips": [{ "id": "desk", "enabled": true, "transport": { "kind": "serial", "portName": "COM3" } }] } })
            .to_string(),
    );
    let set = strips_from(&registry, persisted.as_ref()).expect("plans");
    assert_eq!(set.driven, vec![driven(serial("COM3"), Some("desk"))]);
    assert!(set.summary().contains("serial:COM3->desk"));

    assert_eq!(
        strips_from(&registry, None).expect("plans").driven,
        vec![driven(serial("COM3"), None)]
    );

    registry.poison_for_tests();
    let refused = strips_from(&registry, None).expect_err("a poisoned registry refuses");
    assert!(refused.starts_with("LIGHTING_CONNECTION_STATE_LOCK_FAILED"));
}
