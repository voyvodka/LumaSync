//! The tray's labels as the frontend pushes them. The status line used to be a
//! hardcoded, untranslated "● Idle" that never moved; it now carries whatever
//! the frontend sends, and a push without it fails as a whole rather than
//! leaving the line stale.
//!
//! Only the wire shape is tested here: `muda` builds menus on the main thread
//! alone, which a test thread is not, so `apply_tray_labels` cannot run here.

use serde_json::json;

use crate::TrayLabels;

fn labels() -> serde_json::Value {
    json!({
        "openSettings": "Open LumaSync",
        "status": "● Ambilight · USB + Hue",
        "lightsOff": "Lights Off",
        "ambilight": "Ambilight",
        "solidColor": "Solid Color",
        "lockedModes": ["ambilight", "solid"],
        "showLedPreview": "LED Preview",
        "closeOverlays": "Close Overlays",
        "quit": "Quit LumaSync",
    })
}

#[test]
fn the_status_line_arrives_with_the_labels() {
    let pushed: TrayLabels = serde_json::from_value(labels()).expect("labels deserialize");
    assert_eq!(pushed.status, "● Ambilight · USB + Hue");
    assert_eq!(pushed.open_settings, "Open LumaSync");
}

#[test]
fn the_mode_locks_arrive_with_the_labels() {
    use crate::commands::lighting_mode::LightingModeKind;

    let pushed: TrayLabels = serde_json::from_value(labels()).expect("labels deserialize");
    assert_eq!(
        pushed.locked_modes,
        vec![LightingModeKind::Ambilight, LightingModeKind::Solid]
    );
    assert_eq!(pushed.ambilight, "Ambilight");
}

#[test]
fn a_push_without_the_status_line_is_rejected() {
    let mut partial = labels();
    partial.as_object_mut().expect("object").remove("status");
    assert!(serde_json::from_value::<TrayLabels>(partial).is_err());
}
