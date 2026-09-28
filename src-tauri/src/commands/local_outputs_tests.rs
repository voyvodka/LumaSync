use std::net::Ipv4Addr;

use super::{DrivenLocal, LocalOutputRegistry, LocalOutputStatus};
use crate::commands::device_connection::{command_status, SerialConnectionStatus};
use crate::commands::wled_sink::{WledProtocol, WledSinkConfig};

fn connected(port: &str, at: u128) -> SerialConnectionStatus {
    SerialConnectionStatus {
        port_name: Some(port.to_string()),
        connected: true,
        status: command_status("CONNECT_OK", "ok", None),
        updated_at_unix_ms: at,
        firmware: None,
    }
}

fn failed(code: &str) -> SerialConnectionStatus {
    SerialConnectionStatus {
        port_name: None,
        connected: false,
        status: command_status(code, "failed", None),
        updated_at_unix_ms: 1,
        firmware: None,
    }
}

fn wled(last_octet: u8) -> WledSinkConfig {
    WledSinkConfig {
        ip: Ipv4Addr::new(192, 168, 1, last_octet),
        port: 21324,
        led_count: 60,
        protocol: WledProtocol::Drgb,
    }
}

fn serial_entry(registry: &LocalOutputRegistry, port: &str) -> Option<(bool, String)> {
    registry
        .snapshot()
        .outputs
        .into_iter()
        .find_map(|output| match output {
            LocalOutputStatus::Serial(entry) if entry.port_name == port => {
                Some((entry.connected, entry.status.code))
            }
            _ => None,
        })
}

#[test]
fn a_connected_strip_is_driven_and_listed() {
    let registry = LocalOutputRegistry::default();
    let snapshot = registry.serial_connected(connected("COM3", 5));

    assert_eq!(snapshot.revision, 1);
    assert_eq!(registry.driven(), Some(DrivenLocal::Serial("COM3".into())));
    assert_eq!(
        serial_entry(&registry, "COM3"),
        Some((true, "CONNECT_OK".into()))
    );
}

// Bug A: a failed serial attempt used to empty the sink slot, WLED and all.
#[test]
fn a_failed_serial_attempt_leaves_a_bound_wled_device_driven() {
    let registry = LocalOutputRegistry::default();
    registry.wled_bound(wled(42));

    registry.serial_failed(Some("COM3"), failed("CONNECT_TIMEOUT"));

    assert_eq!(registry.driven(), Some(DrivenLocal::Wled(wled(42))));
    assert_eq!(
        serial_entry(&registry, "COM3"),
        Some((false, "CONNECT_TIMEOUT".into()))
    );
}

// A connect never moves what is driven: a strip lighting a running mode keeps lighting it.
#[test]
fn binding_wled_leaves_the_connected_strip_driven() {
    let registry = LocalOutputRegistry::default();
    registry.serial_connected(connected("COM3", 5));

    registry.wled_bound(wled(42));

    assert_eq!(
        serial_entry(&registry, "COM3"),
        Some((true, "CONNECT_OK".into()))
    );
    assert_eq!(registry.wled_config(), Some(wled(42)));
    assert_eq!(registry.driven(), Some(DrivenLocal::Serial("COM3".into())));
}

#[test]
fn connecting_a_strip_leaves_the_bound_wled_device_driven() {
    let registry = LocalOutputRegistry::default();
    registry.wled_bound(wled(42));

    registry.serial_connected(connected("COM3", 5));

    assert_eq!(registry.wled_config(), Some(wled(42)));
    assert_eq!(registry.driven(), Some(DrivenLocal::Wled(wled(42))));
}

// Only a leave moves what is driven, onto the earliest of what remains.
#[test]
fn a_leave_moves_the_drive_onto_the_earliest_remaining_output() {
    let registry = LocalOutputRegistry::default();
    registry.serial_connected(connected("COM3", 5));
    registry.wled_bound(wled(42));
    registry.serial_connected(connected("COM4", 6));

    registry.serial_disconnected("COM3").expect("connected");
    assert_eq!(registry.driven(), Some(DrivenLocal::Wled(wled(42))));

    registry.wled_forgotten(wled(42).ip).expect("bound");
    assert_eq!(registry.driven(), Some(DrivenLocal::Serial("COM4".into())));
}

// A second connect of a live port (a replug racing a Connect) keeps its place in the order.
#[test]
fn connecting_a_connected_port_again_keeps_its_place() {
    let registry = LocalOutputRegistry::default();
    registry.serial_connected(connected("COM3", 5));
    registry.serial_connected(connected("COM4", 6));

    registry.serial_connected(connected("COM3", 7));

    assert_eq!(registry.driven(), Some(DrivenLocal::Serial("COM3".into())));
}

// Bug C: a failed attempt on another port overwrote the one status a live strip lived in.
#[test]
fn a_failed_attempt_on_another_port_leaves_the_connected_strip_driven() {
    let registry = LocalOutputRegistry::default();
    registry.serial_connected(connected("COM3", 5));

    registry.serial_failed(Some("COM4"), failed("CONNECT_IO_ERROR"));

    assert_eq!(registry.driven(), Some(DrivenLocal::Serial("COM3".into())));
    assert_eq!(
        serial_entry(&registry, "COM4"),
        Some((false, "CONNECT_IO_ERROR".into()))
    );
}

#[test]
fn a_second_strip_joins_the_first_which_stays_driven() {
    let registry = LocalOutputRegistry::default();
    registry.serial_connected(connected("COM3", 5));

    registry.serial_connected(connected("COM4", 6));

    assert_eq!(
        serial_entry(&registry, "COM3"),
        Some((true, "CONNECT_OK".into()))
    );
    assert_eq!(
        registry.connected_serial_ports(),
        vec!["COM3".to_string(), "COM4".to_string()]
    );
    assert_eq!(registry.driven(), Some(DrivenLocal::Serial("COM3".into())));
}

// A refused name comes straight from IPC; it must not grow the map.
#[test]
fn a_refused_port_name_is_not_recorded() {
    let registry = LocalOutputRegistry::default();

    registry.serial_failed(None, failed("PORT_UNSUPPORTED"));

    assert!(registry.snapshot().outputs.is_empty());
}

#[test]
fn the_watcher_clears_a_lost_strip_only_when_nothing_connected_it_after_the_listing() {
    let registry = LocalOutputRegistry::default();
    registry.serial_connected(connected("COM3", 35));

    assert!(registry.serial_lost("COM3", 30).is_none());
    assert_eq!(registry.driven(), Some(DrivenLocal::Serial("COM3".into())));

    let cleared = registry.serial_lost("COM3", 40).expect("cleared");
    assert_eq!(cleared.revision, 2);
    assert_eq!(
        serial_entry(&registry, "COM3"),
        Some((false, "PORT_NOT_FOUND".into()))
    );
    assert!(registry.serial_lost("COM3", 50).is_none());
}

#[test]
fn forgetting_a_different_wled_device_changes_nothing() {
    let registry = LocalOutputRegistry::default();
    registry.wled_bound(wled(42));

    assert!(registry
        .wled_forgotten(Ipv4Addr::new(192, 168, 1, 7))
        .is_none());
    assert!(registry
        .wled_forgotten(Ipv4Addr::new(192, 168, 1, 42))
        .is_some());
    assert_eq!(registry.driven(), None);
}

#[test]
fn a_disconnect_restores_when_the_lighting_refuses_and_nothing_took_the_place() {
    let registry = LocalOutputRegistry::default();
    registry.serial_connected(connected("COM3", 5));

    let (_, previous) = registry.serial_disconnected("COM3").expect("connected");
    assert_eq!(registry.driven(), None);
    assert_eq!(
        serial_entry(&registry, "COM3"),
        Some((false, "DISCONNECTED".into()))
    );

    registry.restore_serial(previous).expect("restored");
    assert_eq!(registry.driven(), Some(DrivenLocal::Serial("COM3".into())));
    assert_eq!(
        serial_entry(&registry, "COM3"),
        Some((true, "CONNECT_OK".into()))
    );
}

// A refused disconnect goes back where it was: ahead of an output connected meanwhile.
#[test]
fn a_refused_disconnect_is_restored_in_its_old_place() {
    let registry = LocalOutputRegistry::default();
    registry.serial_connected(connected("COM3", 5));
    let (_, previous) = registry.serial_disconnected("COM3").expect("connected");
    registry.wled_bound(wled(42));

    registry.restore_serial(previous).expect("restored");

    assert_eq!(registry.driven(), Some(DrivenLocal::Serial("COM3".into())));
}

// Connected again since the disconnect: that is newer than what the restore holds.
#[test]
fn a_disconnect_is_not_restored_over_the_same_port_connected_since() {
    let registry = LocalOutputRegistry::default();
    registry.serial_connected(connected("COM3", 5));
    let (_, previous) = registry.serial_disconnected("COM3").expect("connected");
    registry.wled_bound(wled(42));
    registry.serial_connected(connected("COM3", 9));

    assert!(registry.restore_serial(previous).is_none());
    assert_eq!(registry.driven(), Some(DrivenLocal::Wled(wled(42))));
}

#[test]
fn a_refused_forget_binds_the_device_again_in_its_old_place() {
    let registry = LocalOutputRegistry::default();
    registry.wled_bound(wled(42));
    registry.serial_connected(connected("COM3", 5));
    let at = registry.wled_connected_at();
    registry.wled_forgotten(wled(42).ip).expect("bound");

    registry.restore_wled(wled(42), at).expect("restored");

    assert_eq!(registry.driven(), Some(DrivenLocal::Wled(wled(42))));
}

#[test]
fn shutdown_lets_every_output_go() {
    let registry = LocalOutputRegistry::default();
    registry.serial_connected(connected("COM3", 5));
    registry.serial_connected(connected("COM4", 6));
    registry.wled_bound(wled(42));

    registry.clear();

    assert!(registry.connected_serial_ports().is_empty());
    assert_eq!(registry.driven(), None);
}

#[test]
fn only_the_connected_port_can_be_disconnected() {
    let registry = LocalOutputRegistry::default();
    registry.serial_failed(Some("COM3"), failed("CONNECT_TIMEOUT"));

    assert!(registry.serial_disconnected("COM3").is_none());
    assert!(registry.serial_disconnected("COM9").is_none());
}

#[test]
fn the_snapshot_serialises_as_the_contract_says() {
    let registry = LocalOutputRegistry::default();
    registry.serial_failed(Some("COM3"), failed("CONNECT_TIMEOUT"));
    registry.wled_bound(wled(42));

    let json = serde_json::to_value(registry.snapshot()).expect("serialises");

    assert_eq!(json["revision"], 2);
    assert_eq!(json["outputs"][0]["kind"], "serial");
    assert_eq!(json["outputs"][0]["portName"], "COM3");
    assert_eq!(json["outputs"][0]["firmware"], serde_json::Value::Null);
    assert!(json["outputs"][0]["updatedAtUnixMs"].is_number());
    assert_eq!(json["outputs"][1]["kind"], "wled");
    assert_eq!(json["outputs"][1]["ip"], "192.168.1.42");
    assert_eq!(json["outputs"][1]["ledCount"], 60);
    assert_eq!(json["outputs"][1]["connected"], true);
}

// Two boot reconnects of one port: the second fails on the open, and the strip that lights stays on.
#[test]
fn a_failed_attempt_on_the_connected_port_leaves_it_connected() {
    let registry = LocalOutputRegistry::default();
    registry.serial_connected(connected("COM3", 5));

    registry.serial_failed(Some("COM3"), failed("CONNECT_IO_ERROR"));

    assert_eq!(
        serial_entry(&registry, "COM3"),
        Some((true, "CONNECT_OK".into()))
    );
    assert_eq!(registry.driven(), Some(DrivenLocal::Serial("COM3".into())));
}

// The frontend reads which output is driven from here, instead of repeating the rule.
#[test]
fn the_snapshot_names_the_driven_output() {
    let registry = LocalOutputRegistry::default();
    assert_eq!(
        serde_json::to_value(registry.snapshot()).expect("serialises")["driven"],
        serde_json::Value::Null
    );

    registry.serial_connected(connected("COM3", 5));
    let json = serde_json::to_value(registry.snapshot()).expect("serialises");
    assert_eq!(
        json["driven"],
        serde_json::json!({ "kind": "serial", "portName": "COM3" })
    );

    registry.wled_bound(wled(42));
    registry.serial_disconnected("COM3").expect("connected");
    let json = serde_json::to_value(registry.snapshot()).expect("serialises");
    assert_eq!(
        json["driven"],
        serde_json::json!({ "kind": "wled", "ip": "192.168.1.42" })
    );
}

// ---------------------------------------------------------------------------
// disconnect_serial_port, over the lighting transaction
// ---------------------------------------------------------------------------

mod disconnect {
    use serde_json::json;
    use tauri::async_runtime::block_on;
    use tauri::Manager;

    use super::super::{disconnect_serial_with, DrivenLocal, LocalOutputRegistry};
    use crate::commands::lighting_mode::outputs::{
        apply_outputs_with, ApplyOutputsRequest, LightingOrigin,
    };
    use crate::commands::lighting_mode::{
        LightingModeConfig, LightingModeKind, Rig, RigSetup, SolidColorPayload, TEST_PORT as PORT,
    };

    fn solid_on(rig: &Rig, targets: &[&str]) {
        let started = block_on(apply_outputs_with(
            &rig.handle(),
            ApplyOutputsRequest {
                mode: Some(LightingModeConfig {
                    kind: LightingModeKind::Solid,
                    solid: Some(SolidColorPayload {
                        r: 200,
                        g: 20,
                        b: 30,
                        brightness: 1.0,
                    }),
                    ..LightingModeConfig::default()
                }),
                targets: Some(targets.iter().map(|t| t.to_string()).collect()),
                origin: LightingOrigin::User,
            },
        ))
        .expect("apply resolves");
        assert_eq!(started.status.code, "OUTPUTS_APPLIED", "setup: {started:?}");
    }

    // Like an unplug: session only, the strip stays chosen for when it is back.
    #[test]
    fn disconnecting_the_strip_ends_a_mode_it_ran_alone_and_keeps_it_chosen() {
        let rig = Rig::new(RigSetup::default());
        rig.set_serial_connected(true);
        solid_on(&rig, &["usb"]);

        let result = block_on(disconnect_serial_with(&rig.handle(), PORT));

        assert_eq!(result.status.code, "SERIAL_DISCONNECT_OK");
        let snapshot = rig.state().snapshot.read();
        assert_eq!(snapshot.mode.kind, LightingModeKind::Off);
        assert!(snapshot.active_targets.is_empty());
        assert!(!rig.worker_running());
        assert_eq!(rig.saved("lastOutputTargets"), Some(json!(["usb"])));
        assert_eq!(rig.app.state::<LocalOutputRegistry>().driven(), None);
    }

    // Stopping only stops writing: a Solid colour would stay lit on a strip the user let go of.
    #[test]
    fn a_disconnected_strip_is_painted_black_and_its_writer_let_go() {
        let rig = Rig::new(RigSetup::default());
        rig.set_serial_connected(true);
        solid_on(&rig, &["usb"]);
        let packets_before = rig.log.packets().len();

        block_on(disconnect_serial_with(&rig.handle(), PORT));

        let packets = rig.log.packets();
        assert!(
            packets.len() > packets_before,
            "a black frame followed the stop"
        );
        let (_, black) = packets.last().expect("a packet");
        assert!(
            black.iter().skip(5).take(3).all(|byte| *byte == 0),
            "{black:?}"
        );
        assert_eq!(rig.log.forgotten(), vec![PORT.to_string()]);
    }

    #[test]
    fn a_strip_that_is_not_connected_is_not_disconnected() {
        let rig = Rig::new(RigSetup::default());
        rig.set_serial_connected(true);

        let result = block_on(disconnect_serial_with(&rig.handle(), "COM-OTHER"));

        assert_eq!(result.status.code, "SERIAL_DISCONNECT_NOT_CONNECTED");
        assert_eq!(
            rig.app.state::<LocalOutputRegistry>().driven(),
            Some(DrivenLocal::Serial(PORT.to_string()))
        );
    }
}

// ---------------------------------------------------------------------------
// A leave with another output connected: the mode moves onto what remains
// ---------------------------------------------------------------------------

mod leave {
    use tauri::async_runtime::block_on;
    use tauri::Manager;

    use super::super::{disconnect_serial_with, DrivenLocal, LocalOutputRegistry};
    use crate::commands::lighting_mode::outputs::{
        apply_outputs_with, ApplyOutputsRequest, LightingOrigin,
    };
    use crate::commands::lighting_mode::snapshot::OutputTarget;
    use crate::commands::lighting_mode::{
        LightingModeConfig, LightingModeKind, Rig, RigSetup, SolidColorPayload, TEST_PORT as PORT,
    };
    use crate::commands::wled_discovery::forget_wled_with;
    use crate::commands::wled_sink::{WledProtocol, WledSinkConfig};

    const OTHER_PORT: &str = "COM-OTHER";

    // Loopback and the discard port: a frame sent to it goes nowhere.
    fn wled() -> WledSinkConfig {
        WledSinkConfig {
            ip: "127.0.0.1".parse().expect("loopback"),
            port: 9,
            led_count: 1,
            protocol: WledProtocol::Drgb,
        }
    }

    fn solid_on_usb(rig: &Rig) {
        let started = block_on(apply_outputs_with(
            &rig.handle(),
            ApplyOutputsRequest {
                mode: Some(LightingModeConfig {
                    kind: LightingModeKind::Solid,
                    solid: Some(SolidColorPayload {
                        r: 200,
                        g: 20,
                        b: 30,
                        brightness: 1.0,
                    }),
                    ..LightingModeConfig::default()
                }),
                targets: Some(vec!["usb".to_string()]),
                origin: LightingOrigin::User,
            },
        ))
        .expect("apply resolves");
        assert_eq!(started.status.code, "OUTPUTS_APPLIED", "setup: {started:?}");
    }

    fn modes_applied(rig: &Rig) -> usize {
        rig.log
            .events()
            .iter()
            .filter(|event| event.starts_with("mode:"))
            .count()
    }

    #[test]
    fn disconnecting_the_driven_strip_moves_the_mode_onto_the_wled_device() {
        let rig = Rig::new(RigSetup::default());
        rig.set_serial_connected(true);
        rig.app.state::<LocalOutputRegistry>().wled_bound(wled());
        solid_on_usb(&rig);
        assert!(rig.state().drives_serial(PORT));

        let result = block_on(disconnect_serial_with(&rig.handle(), PORT));

        assert_eq!(result.status.code, "SERIAL_DISCONNECT_OK");
        let snapshot = rig.state().snapshot.read();
        assert_eq!(snapshot.mode.kind, LightingModeKind::Solid);
        assert!(snapshot.active_targets.contains(&OutputTarget::Usb));
        assert!(rig.state().drives_wled(wled().ip));
        assert_eq!(
            rig.app.state::<LocalOutputRegistry>().driven(),
            Some(DrivenLocal::Wled(wled()))
        );
        let (_, black) = rig.log.packets().last().cloned().expect("a packet");
        assert!(
            black.iter().skip(5).take(3).all(|byte| *byte == 0),
            "{black:?}"
        );
        assert_eq!(rig.log.forgotten(), vec![PORT.to_string()]);
    }

    // Black alone lasts only until the device goes back to its own effect.
    #[test]
    fn forgetting_the_driven_wled_device_moves_onto_the_strip_and_switches_it_off() {
        let rig = Rig::new(RigSetup {
            serial_connected: false,
            ..RigSetup::default()
        });
        rig.app.state::<LocalOutputRegistry>().wled_bound(wled());
        rig.set_serial_connected(true);
        solid_on_usb(&rig);
        assert!(rig.state().drives_wled(wled().ip));

        let result = block_on(forget_wled_with(&rig.handle(), "127.0.0.1"));

        assert_eq!(result.status.code, "WLED_FORGET_OK");
        assert!(rig.state().drives_serial(PORT));
        assert!(rig.log.events().contains(&"wled:off:127.0.0.1".to_string()));
        assert!(rig
            .state()
            .snapshot
            .read()
            .active_targets
            .contains(&OutputTarget::Usb));
    }

    // Switched off alone, a device in realtime mode shows its last frame until that times out.
    #[test]
    fn forgetting_the_driven_wled_device_paints_it_black_first() {
        let device = std::net::UdpSocket::bind("127.0.0.1:0").expect("bind");
        device
            .set_read_timeout(Some(std::time::Duration::from_millis(500)))
            .expect("timeout");
        let config = WledSinkConfig {
            port: device.local_addr().expect("addr").port(),
            ..wled()
        };
        let rig = Rig::new(RigSetup {
            serial_connected: false,
            ..RigSetup::default()
        });
        rig.app.state::<LocalOutputRegistry>().wled_bound(config);
        rig.set_serial_connected(true);
        solid_on_usb(&rig);
        assert!(rig.state().drives_wled(config.ip));
        // `recv_from`: Windows refuses `recv` on a socket that is not connected.
        let mut datagram = [0u8; 2048];
        let (len, _) = device.recv_from(&mut datagram).expect("the Solid frame");
        assert!(datagram[2..len].iter().any(|byte| *byte != 0));

        let result = block_on(forget_wled_with(&rig.handle(), "127.0.0.1"));

        assert_eq!(result.status.code, "WLED_FORGET_OK");
        let (len, _) = device.recv_from(&mut datagram).expect("a black frame");
        assert_eq!(datagram[0], 2, "DRGB");
        assert!(
            datagram[2..len].iter().all(|byte| *byte == 0),
            "{:?}",
            &datagram[..len]
        );
    }

    #[test]
    fn forgetting_a_wled_device_nothing_drives_leaves_the_mode_alone() {
        let rig = Rig::new(RigSetup::default());
        rig.set_serial_connected(true);
        rig.app.state::<LocalOutputRegistry>().wled_bound(wled());
        solid_on_usb(&rig);
        let applied = modes_applied(&rig);

        let result = block_on(forget_wled_with(&rig.handle(), "127.0.0.1"));

        assert_eq!(result.status.code, "WLED_FORGET_OK");
        assert_eq!(modes_applied(&rig), applied);
        assert!(!rig
            .log
            .events()
            .iter()
            .any(|event| event.starts_with("wled:off")));
        assert!(rig.state().drives_serial(PORT));
    }

    #[test]
    fn disconnecting_a_strip_nothing_drives_leaves_the_mode_alone() {
        let rig = Rig::new(RigSetup::default());
        rig.set_serial_connected(true);
        rig.app
            .state::<LocalOutputRegistry>()
            .set_serial_for_tests(OTHER_PORT, true, 0);
        solid_on_usb(&rig);
        let applied = modes_applied(&rig);
        let packets = rig.log.packets().len();

        let result = block_on(disconnect_serial_with(&rig.handle(), OTHER_PORT));

        assert_eq!(result.status.code, "SERIAL_DISCONNECT_OK");
        assert_eq!(modes_applied(&rig), applied);
        assert_eq!(rig.log.packets().len(), packets, "nothing painted");
        assert!(rig.state().drives_serial(PORT));
        assert_eq!(rig.log.forgotten(), vec![OTHER_PORT.to_string()]);
    }

    // The watcher's loss of the driven strip, with a WLED device still bound: the mode moves onto it.
    #[test]
    fn an_unplugged_driven_strip_moves_the_mode_onto_what_remains() {
        let rig = Rig::new(RigSetup::default());
        rig.set_serial_connected(true);
        rig.app.state::<LocalOutputRegistry>().wled_bound(wled());
        solid_on_usb(&rig);
        rig.app
            .state::<LocalOutputRegistry>()
            .serial_lost(PORT, u128::MAX)
            .expect("cleared");

        crate::commands::device_connection::follow_lost_ports(&rig.handle(), &[PORT.to_string()]);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !rig.state().drives_wled(wled().ip) {
            assert!(
                std::time::Instant::now() < deadline,
                "the mode never moved onto the WLED device"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(rig
            .state()
            .snapshot
            .read()
            .active_targets
            .contains(&OutputTarget::Usb));
        assert_eq!(rig.log.forgotten(), vec![PORT.to_string()]);
    }

    #[test]
    fn an_unplugged_strip_nothing_drives_moves_nothing() {
        let rig = Rig::new(RigSetup::default());
        rig.set_serial_connected(true);
        rig.app
            .state::<LocalOutputRegistry>()
            .set_serial_for_tests(OTHER_PORT, true, 0);
        solid_on_usb(&rig);
        let applied = modes_applied(&rig);

        crate::commands::device_connection::follow_lost_ports(
            &rig.handle(),
            &[OTHER_PORT.to_string()],
        );
        std::thread::sleep(std::time::Duration::from_millis(50));

        assert_eq!(modes_applied(&rig), applied);
        assert!(rig.state().drives_serial(PORT));
    }
}
