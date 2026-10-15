use std::net::Ipv4Addr;

use serde_json::json;

use super::strip_set::{
    resolve_strips, strips_from, DrivenStrip, LeftOutReason, LeftOutStrip, StripSet,
};
use super::usb_output::UsbOutputPlan;
use crate::commands::device_connection::{command_status, SerialConnectionStatus};
use crate::commands::led_output::{FirmwareProfile, LedChipType, LedColorOrder};
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

/// A driven strip by what identifies it: the output and the saved strip it is.
fn driven(output: DrivenLocal, strip_id: Option<&str>) -> (DrivenLocal, Option<String>) {
    (output, strip_id.map(str::to_string))
}

fn ids(strips: &[DrivenStrip]) -> Vec<(DrivenLocal, Option<String>)> {
    strips
        .iter()
        .map(|strip| (strip.output.clone(), strip.strip_id.clone()))
        .collect()
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
    assert_eq!(ids(&set.driven), vec![driven(serial("COM3"), None)]);
    assert!(set.left_out.is_empty());
    assert_eq!(set.primary(), Some(&serial("COM3")));
}

#[test]
fn a_connected_port_is_matched_to_its_saved_strip() {
    let set = resolve_strips(&[on_port("strip-1", "COM3")], vec![serial("COM3")]);
    assert_eq!(
        ids(&set.driven),
        vec![driven(serial("COM3"), Some("strip-1"))]
    );
    assert!(set.left_out.is_empty());
}

#[test]
fn a_saved_strip_whose_port_is_not_connected_is_left_out() {
    let set = resolve_strips(
        &[on_port("strip-1", "COM3"), on_port("strip-2", "COM4")],
        vec![serial("COM4")],
    );
    assert_eq!(
        ids(&set.driven),
        vec![driven(serial("COM4"), Some("strip-2"))]
    );
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
        ids(&set.driven),
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
    assert_eq!(ids(&set.driven), vec![driven(live, Some("strip-2"))]);

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
    assert_eq!(
        ids(&set.driven),
        vec![driven(serial("COM3"), Some("first"))]
    );
    assert_eq!(
        set.left_out,
        vec![left_out("second", LeftOutReason::DuplicateTransport)]
    );
}

#[test]
fn enabled_does_not_decide_the_primary_or_the_plan() {
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
    assert_eq!(
        ids(&set.driven),
        vec![driven(serial("COM3"), Some("strip-1"))]
    );
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
    assert_eq!(ids(&set.driven), vec![driven(serial("COM3"), Some("desk"))]);
    assert!(set.summary().contains("serial:COM3->desk"));

    assert_eq!(
        ids(&strips_from(&registry, None).expect("plans").driven),
        vec![driven(serial("COM3"), None)]
    );

    registry.poison_for_tests();
    let refused = strips_from(&registry, None).expect_err("a poisoned registry refuses");
    assert!(refused.starts_with("LIGHTING_CONNECTION_STATE_LOCK_FAILED"));
}

// -----------------------------------------------------------------------
// The rules the fan-out drives by
// -----------------------------------------------------------------------

fn layout(total: u16) -> serde_json::Value {
    json!({
        "counts": { "top": total, "right": 0, "bottom": 0, "left": 0 },
        "bottomMissing": 0,
        "cornerOwnership": "horizontal",
        "visualPreset": "vivid",
        "startAnchor": "left-end",
        "direction": "cw",
        "totalLeds": total
    })
}

fn laid_out(id: &str, port: &str, enabled: bool, total: Option<u16>) -> LedStrip {
    LedStrip {
        layout: total.map(layout),
        ..saved(
            id,
            Some(StripTransport::Serial {
                port_name: port.to_string(),
            }),
            enabled,
        )
    }
}

#[test]
fn the_mode_is_for_the_saved_primary_when_it_is_connected() {
    // strip-1 is the saved primary but connected second.
    let set = resolve_strips(
        &[
            laid_out("strip-1", "COM3", true, Some(60)),
            laid_out("strip-2", "COM4", true, Some(60)),
        ],
        vec![serial("COM4"), serial("COM3")],
    );
    assert_eq!(set.primary_saved.as_deref(), Some("strip-1"));
    assert_eq!(set.payload_index(), Some(1));
    // `primary` and the plan still take the earliest connected until the worker fans out.
    assert_eq!(set.primary(), Some(&serial("COM4")));
}

#[test]
fn the_mode_falls_back_to_the_earliest_connected_rather_than_to_nothing() {
    let unplugged_primary = resolve_strips(
        &[
            laid_out("strip-1", "COM3", true, Some(60)),
            laid_out("strip-2", "COM4", true, Some(60)),
        ],
        vec![serial("COM4")],
    );
    assert_eq!(unplugged_primary.payload_index(), Some(0));

    let all_disabled = resolve_strips(
        &[laid_out("strip-1", "COM3", false, Some(60))],
        vec![serial("COM3")],
    );
    assert_eq!(all_disabled.primary_saved, None);
    assert_eq!(all_disabled.payload_index(), Some(0));

    let unsaved = resolve_strips(&[], vec![serial("COM3"), serial("COM4")]);
    assert_eq!(unsaved.payload_index(), Some(0));
    assert_eq!(resolve_strips(&[], vec![]).payload_index(), None);
}

#[test]
fn beside_the_mode_s_strip_only_saved_enabled_laid_out_strips_of_its_kind_are_driven() {
    let wled = WledSinkConfig {
        ip: Ipv4Addr::new(192, 168, 1, 9),
        port: 21324,
        led_count: 60,
        protocol: WledProtocol::Ddp,
    };
    let strips = [
        laid_out("primary", "COM1", true, Some(60)),
        laid_out("good", "COM2", true, Some(90)),
        laid_out("off", "COM3", false, Some(60)),
        laid_out("bare", "COM4", true, None),
        laid_out("one", "COM5", true, Some(1)),
        LedStrip {
            layout: Some(
                json!({ "totalLeds": 60, "counts": { "top": 10, "right": 0, "bottom": 0, "left": 0 },
                "bottomMissing": 0, "cornerOwnership": "horizontal", "visualPreset": "vivid",
                "startAnchor": "left-end", "direction": "cw" }),
            ),
            ..laid_out("broken", "COM6", true, None)
        },
        LedStrip {
            layout: Some(layout(60)),
            ..saved(
                "panel",
                Some(StripTransport::Wled {
                    sink: json!({ "ip": "192.168.1.9" }),
                }),
                true,
            )
        },
    ];
    let set = resolve_strips(
        &strips,
        vec![
            serial("COM1"),
            serial("COM2"),
            serial("COM3"),
            serial("COM4"),
            serial("COM5"),
            serial("COM6"),
            DrivenLocal::Wled(wled),
            serial("COM7"),
        ],
    );
    let fan = set.fan_out();
    assert_eq!(fan.payload, Some(0));
    assert_eq!(fan.others, vec![1]);
    assert_eq!(
        fan.left_out,
        vec![
            left_out("off", LeftOutReason::Disabled),
            left_out("bare", LeftOutReason::NoLayout),
            left_out("one", LeftOutReason::InvalidLayout),
            left_out("broken", LeftOutReason::InvalidLayout),
            left_out("panel", LeftOutReason::OtherTransport),
        ]
    );
    assert_eq!(fan.unsaved, vec![7]);
    assert!(set.summary().contains("others:[1]"));
}

#[test]
fn a_disabled_strip_is_left_out_before_its_layout_is_looked_at() {
    let set = resolve_strips(
        &[
            laid_out("primary", "COM1", true, Some(60)),
            laid_out("off", "COM2", false, None),
        ],
        vec![serial("COM1"), serial("COM2")],
    );
    assert_eq!(
        set.fan_out().left_out,
        vec![left_out("off", LeftOutReason::Disabled)]
    );
}

#[test]
fn the_mode_s_strip_keeps_today_s_rules_whatever_its_own_setup() {
    // The payload has no layout and is disabled; it is driven all the same, the others judged.
    let set = resolve_strips(
        &[laid_out("only", "COM1", false, None)],
        vec![serial("COM1")],
    );
    let fan = set.fan_out();
    assert_eq!(fan.payload, Some(0));
    assert!(fan.left_out.is_empty() && fan.others.is_empty());
}

#[test]
fn a_saved_strip_carries_its_own_decoded_setup() {
    let strip = LedStrip {
        layout: Some(layout(60)),
        hardware: StripHardware {
            firmware_profile: Some(json!("adalight")),
            chip_type: Some(json!("sk6812-rgbw")),
            color_order: Some(json!("RGB")),
        },
        ..on_port("strip-1", "COM3")
    };
    let set = resolve_strips(&[strip], vec![serial("COM3")]);
    let setup = set.driven[0].saved.as_ref().expect("saved setup");
    assert_eq!(setup.layout.as_ref().map(|l| l.total_leds), Some(60));
    assert_eq!(setup.profile, FirmwareProfile::Adalight);
    assert_eq!(setup.chip, LedChipType::Sk6812Rgbw);
    assert_eq!(setup.color_order, LedColorOrder::Rgb);
    assert!(resolve_strips(&[], vec![serial("COM3")]).driven[0]
        .saved
        .is_none());
}

#[test]
fn every_strip_is_corrected_by_the_one_saved_correction() {
    let registry = LocalOutputRegistry::default();
    connect(&registry, "COM3");
    let state = PersistedShellState::from_file_json(
        &json!({ "shell-state": { "colorCorrection": { "gammaR": 2.4, "gammaG": 2.4, "gammaB": 2.4, "kelvin": 5000, "saturation": 1.1 } } })
            .to_string(),
    );
    let set = strips_from(&registry, state.as_ref()).expect("plans");
    assert_eq!(
        set.driven[0].correction,
        state.unwrap().color_correction().unwrap()
    );
}

#[test]
fn a_caller_naming_its_own_output_gets_that_output_alone() {
    let set = resolve_strips(
        &[on_port("strip-1", "COM3")],
        vec![serial("COM3"), serial("COM4")],
    );
    assert_eq!(
        set.for_plan(Some(&UsbOutputPlan::Serial("COM3".into()))),
        set
    );
    let other = set.for_plan(Some(&UsbOutputPlan::Serial("COM9".into())));
    assert_eq!(ids(&other.driven), vec![driven(serial("COM9"), None)]);
    assert!(other.left_out.is_empty() && other.primary_saved.is_none());
    assert_eq!(set.for_plan(None), StripSet::default());
}
