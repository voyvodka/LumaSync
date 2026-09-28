//! The saved setup read as strips: one run of LEDs behind one local
//! controller, with the hardware, layout and correction that belong to it.
//! Stored under `ledStrips` from schema 8 and read by the same rules as
//! `readStoredStrips` in `src/features/strips/model/storedStrips.ts`. A file
//! without the key (never migrated) is derived from the single-output keys,
//! as `stripsFromLegacy` in `src/features/strips/model/legacyStrips.ts` does.
//! A parity fixture per rule tests both sides.
//!
//! Values are carried as the JSON they were saved as and decoded where they
//! are read, so a field this build does not know survives the trip.

use serde_json::{json, Map, Value};

/// `FIRST_STRIP_ID` in `src/shared/contracts/strips.ts`.
pub const FIRST_STRIP_ID: &str = "strip-1";
const SECOND_STRIP_ID: &str = "strip-2";

#[derive(Clone, Debug, PartialEq)]
pub enum StripTransport {
    Serial { port_name: String },
    Wled { sink: Value },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StripHardware {
    pub firmware_profile: Option<Value>,
    pub chip_type: Option<Value>,
    pub color_order: Option<Value>,
}

impl StripHardware {
    fn is_empty(&self) -> bool {
        self.firmware_profile.is_none() && self.chip_type.is_none() && self.color_order.is_none()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LedStrip {
    pub id: String,
    /// The user's name for it; `None` until renamed, and the UI names it after its device.
    pub name: Option<String>,
    pub enabled: bool,
    pub transport: Option<StripTransport>,
    pub hardware: StripHardware,
    pub layout: Option<Value>,
    pub color_correction: Option<Value>,
}

/// `null` reads as absent, as every other shell-state read does.
fn present<'a>(state: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    state.get(key).filter(|value| !value.is_null())
}

/// One strip when anything describes one, none otherwise: a Hue-only install
/// has no strip whatever its colour correction says. A port and a WLED device
/// both saved (the app never writes both) gives the WLED device a second,
/// disabled strip, since the port has always won.
pub fn strips_from_legacy(state: &Map<String, Value>) -> Vec<LedStrip> {
    let serial = present(state, "lastSuccessfulPort")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let wled = present(state, "lastWledSink").cloned();
    let layout = present(state, "ledCalibration").cloned();
    let color_correction = present(state, "colorCorrection").cloned();
    let hardware = StripHardware {
        firmware_profile: present(state, "firmwareProfile").cloned(),
        chip_type: present(state, "selectedChipType").cloned(),
        color_order: present(state, "ledColorOrder").cloned(),
    };
    if serial.is_none() && wled.is_none() && layout.is_none() && hardware.is_empty() {
        return Vec::new();
    }

    let placements: Vec<&Map<String, Value>> = state
        .get("roomMap")
        .and_then(|room_map| room_map.get("usbStrips"))
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default();
    let placement_id = |row: &Map<String, Value>| {
        row.get("stripId")
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let id = serial
        .as_deref()
        .and_then(|port| {
            placements
                .iter()
                .find(|row| row.get("portName").and_then(Value::as_str) == Some(port))
                .and_then(|row| placement_id(row))
        })
        .or_else(|| placements.first().and_then(|row| placement_id(row)))
        .unwrap_or_else(|| FIRST_STRIP_ID.to_owned());

    let transport = match (&serial, &wled) {
        (Some(port_name), _) => Some(StripTransport::Serial {
            port_name: port_name.clone(),
        }),
        (None, Some(sink)) => Some(StripTransport::Wled { sink: sink.clone() }),
        (None, None) => None,
    };
    let second_id = if id == SECOND_STRIP_ID {
        FIRST_STRIP_ID
    } else {
        SECOND_STRIP_ID
    };
    let mut strips = vec![LedStrip {
        id,
        name: None,
        enabled: true,
        transport,
        hardware,
        layout: layout.clone(),
        color_correction: color_correction.clone(),
    }];
    if let (Some(_), Some(sink)) = (serial, wled) {
        strips.push(LedStrip {
            id: second_id.to_owned(),
            name: None,
            enabled: false,
            transport: Some(StripTransport::Wled { sink }),
            hardware: StripHardware::default(),
            layout,
            color_correction,
        });
    }
    strips
}

/// The strips a saved state describes: `ledStrips` when the key holds a
/// value, the legacy derivation when it does not.
pub fn strips_of(state: &Map<String, Value>) -> Vec<LedStrip> {
    match present(state, "ledStrips") {
        Some(stored) => strips_from_stored(stored),
        None => strips_from_legacy(state),
    }
}

/// Stored strips, read leniently: the file may have been edited by hand. A row
/// that is not an object or has no string `id` is skipped; the rest of a row
/// falls back field by field rather than taking the strip down with it.
pub fn strips_from_stored(stored: &Value) -> Vec<LedStrip> {
    let Some(rows) = stored.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(Value::as_object)
        .filter_map(|row| {
            let id = row.get("id").and_then(Value::as_str)?.to_owned();
            let hardware = row.get("hardware").and_then(Value::as_object);
            let hardware_field = |key: &str| hardware.and_then(|map| present(map, key)).cloned();
            Some(LedStrip {
                id,
                // Kept as written: only a blank or non-string value reads as no name.
                name: row
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.trim().is_empty())
                    .map(str::to_owned),
                enabled: row.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                transport: row.get("transport").and_then(transport_from_stored),
                hardware: StripHardware {
                    firmware_profile: hardware_field("firmwareProfile"),
                    chip_type: hardware_field("chipType"),
                    color_order: hardware_field("colorOrder"),
                },
                layout: present(row, "layout").cloned(),
                color_correction: present(row, "colorCorrection").cloned(),
            })
        })
        .collect()
}

fn transport_from_stored(value: &Value) -> Option<StripTransport> {
    let transport = value.as_object()?;
    match transport.get("kind").and_then(Value::as_str)? {
        "serial" => Some(StripTransport::Serial {
            port_name: transport
                .get("portName")
                .and_then(Value::as_str)?
                .to_owned(),
        }),
        "wled" => transport
            .get("sink")
            .filter(|sink| sink.is_object())
            .map(|sink| StripTransport::Wled { sink: sink.clone() }),
        _ => None,
    }
}

/// The strip a setting with no strip named applies to: the first one enabled.
pub fn primary_strip(strips: Vec<LedStrip>) -> Option<LedStrip> {
    strips.into_iter().find(|strip| strip.enabled)
}

/// Drops a saved WLED device from the strips, editing the stored JSON so
/// fields this build does not know survive. The primary strip keeps its
/// layout and hardware with no transport, as removing `lastWledSink` left
/// them; a strip left describing nothing goes, as the legacy derivation gives
/// none. A file never migrated gets `ledStrips` written from the derivation
/// first, the way the frontend's migration would. Returns whether it changed.
pub fn forget_wled_in(state: &mut Map<String, Value>, ip: &str) -> bool {
    let mut rows: Vec<Value> = match present(state, "ledStrips") {
        Some(stored) => stored.as_array().cloned().unwrap_or_default(),
        None => strips_from_legacy(state).iter().map(strip_json).collect(),
    };
    let primary = rows.iter().position(|row| {
        row.get("id").is_some_and(Value::is_string)
            && row.get("enabled").and_then(Value::as_bool).unwrap_or(true)
    });
    let is_this_device = |row: &Value| {
        row.get("transport")
            .and_then(transport_from_stored)
            .is_some_and(|transport| match transport {
                StripTransport::Wled { sink } => {
                    sink.get("ip").and_then(Value::as_str).map(str::trim) == Some(ip.trim())
                }
                StripTransport::Serial { .. } => false,
            })
    };
    let mut changed = false;
    let mut index = 0;
    rows.retain_mut(|row| {
        let at = index;
        index += 1;
        if !is_this_device(row) {
            return true;
        }
        changed = true;
        if Some(at) != primary {
            return false;
        }
        if let Some(object) = row.as_object_mut() {
            object.insert("transport".into(), Value::Null);
        }
        describes_something(row)
    });
    if changed || present(state, "ledStrips").is_none() {
        state.insert("ledStrips".into(), Value::Array(rows));
    }
    changed
}

fn describes_something(row: &Value) -> bool {
    row.get("layout").is_some_and(|layout| !layout.is_null())
        || row
            .get("hardware")
            .and_then(Value::as_object)
            .is_some_and(|hardware| hardware.values().any(|value| !value.is_null()))
}

/// A strip as the frontend's migration writes it, so a list Rust stores first
/// reads the same to both sides.
pub fn strip_json(strip: &LedStrip) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), Value::from(strip.id.clone()));
    if let Some(name) = &strip.name {
        out.insert("name".into(), Value::from(name.clone()));
    }
    out.insert("enabled".into(), Value::from(strip.enabled));
    out.insert(
        "transport".into(),
        match &strip.transport {
            Some(StripTransport::Serial { port_name }) => {
                json!({ "kind": "serial", "portName": port_name })
            }
            Some(StripTransport::Wled { sink }) => json!({ "kind": "wled", "sink": sink }),
            None => Value::Null,
        },
    );
    let mut hardware = Map::new();
    for (key, value) in [
        ("firmwareProfile", &strip.hardware.firmware_profile),
        ("chipType", &strip.hardware.chip_type),
        ("colorOrder", &strip.hardware.color_order),
    ] {
        if let Some(value) = value {
            hardware.insert(key.into(), value.clone());
        }
    }
    out.insert("hardware".into(), Value::Object(hardware));
    if let Some(layout) = &strip.layout {
        out.insert("layout".into(), layout.clone());
    }
    if let Some(correction) = &strip.color_correction {
        out.insert("colorCorrection".into(), correction.clone());
    }
    Value::Object(out)
}

/// What a write changed on the primary strip, named by the single-output keys
/// the running mode's refresh already understands: a layout-only save still
/// takes the calibration fast path. Both sides are read by the same rule, so a
/// change of which strip is primary shows as the fields that differ.
pub fn primary_strip_changes(
    before: &Map<String, Value>,
    after: &Map<String, Value>,
) -> Vec<&'static str> {
    let before = primary_strip(strips_of(before));
    let after = primary_strip(strips_of(after));
    let fields = |strip: &Option<LedStrip>| {
        strip
            .as_ref()
            .map(|strip| {
                [
                    strip.layout.clone(),
                    strip.hardware.firmware_profile.clone(),
                    strip.hardware.chip_type.clone(),
                    strip.hardware.color_order.clone(),
                ]
            })
            .unwrap_or_default()
    };
    let keys = [
        "ledCalibration",
        "firmwareProfile",
        "selectedChipType",
        "ledColorOrder",
    ];
    keys.into_iter()
        .zip(fields(&before).into_iter().zip(fields(&after)))
        .filter(|(_, (was, now))| was != now)
        .map(|(key, _)| key)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{primary_strip, strip_json, strips_from_legacy, StripTransport};
    use serde_json::{json, Value};

    const FIXTURE: &str = include_str!(
        "../../../src/features/strips/model/__tests__/fixtures/legacyStrips.parity.json"
    );

    #[test]
    fn derives_the_same_strips_as_the_frontend() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture parses");
        for case in fixture["cases"].as_array().expect("cases") {
            let state = case["state"].as_object().expect("state is an object");
            let derived: Vec<Value> = strips_from_legacy(state).iter().map(strip_json).collect();
            assert_eq!(
                Value::Array(derived),
                case["strips"],
                "case: {}",
                case["name"]
            );
        }
    }

    const STORED_FIXTURE: &str = include_str!(
        "../../../src/features/strips/model/__tests__/fixtures/storedStrips.parity.json"
    );

    #[test]
    fn reads_stored_strips_as_the_frontend_does() {
        let fixture: Value = serde_json::from_str(STORED_FIXTURE).expect("fixture parses");
        for case in fixture["cases"].as_array().expect("cases") {
            let derived: Vec<Value> = super::strips_from_stored(&case["stored"])
                .iter()
                .map(strip_json)
                .collect();
            assert_eq!(
                Value::Array(derived),
                case["strips"],
                "case: {}",
                case["name"]
            );
        }
    }

    #[test]
    fn stored_strips_win_over_the_legacy_keys() {
        let state = json!({
            "lastSuccessfulPort": "COM3",
            "ledStrips": [{ "id": "a", "enabled": true, "transport": null, "hardware": {} }]
        });
        let strips = super::strips_of(state.as_object().unwrap());
        assert_eq!(strips.len(), 1);
        assert_eq!(strips[0].transport, None);
        let null = json!({ "lastSuccessfulPort": "COM3", "ledStrips": null });
        assert!(matches!(
            super::strips_of(null.as_object().unwrap())[0].transport,
            Some(StripTransport::Serial { .. })
        ));
    }

    fn wled(ip: &str) -> Value {
        json!({ "ip": ip, "port": 21324, "ledCount": 60, "protocol": "drgb" })
    }

    #[test]
    fn forgetting_a_wled_device_keeps_the_primary_strip_layout() {
        let mut state = json!({
            "ledStrips": [{
                "id": "s1", "enabled": true, "future": 1,
                "transport": { "kind": "wled", "sink": wled("10.0.0.5") },
                "hardware": {}, "layout": { "totalLeds": 60 }
            }]
        });
        let map = state.as_object_mut().unwrap();
        assert!(super::forget_wled_in(map, " 10.0.0.5 "));
        assert_eq!(
            map["ledStrips"],
            json!([{ "id": "s1", "enabled": true, "future": 1, "transport": null,
                     "hardware": {}, "layout": { "totalLeds": 60 } }])
        );
    }

    #[test]
    fn forgetting_drops_a_waiting_strip_and_one_that_describes_nothing() {
        let mut state = json!({
            "ledStrips": [
                { "id": "s1", "enabled": true, "transport": { "kind": "wled", "sink": wled("10.0.0.5") }, "hardware": {} },
                { "id": "s2", "enabled": false, "transport": { "kind": "wled", "sink": wled("10.0.0.6") }, "hardware": {} }
            ]
        });
        let map = state.as_object_mut().unwrap();
        assert!(super::forget_wled_in(map, "10.0.0.6"));
        assert_eq!(map["ledStrips"].as_array().unwrap().len(), 1);
        assert!(super::forget_wled_in(map, "10.0.0.5"));
        assert_eq!(map["ledStrips"], json!([]));
        assert!(!super::forget_wled_in(map, "10.0.0.5"));
    }

    #[test]
    fn forgetting_on_an_unmigrated_file_writes_the_strips_first() {
        let mut state = json!({
            "lastWledSink": wled("10.0.0.5"),
            "ledCalibration": { "totalLeds": 60 }
        });
        let map = state.as_object_mut().unwrap();
        assert!(super::forget_wled_in(map, "10.0.0.5"));
        assert_eq!(
            map["ledStrips"],
            json!([{ "id": "strip-1", "enabled": true, "transport": null,
                     "hardware": {}, "layout": { "totalLeds": 60 } }])
        );
        assert!(
            map.contains_key("lastWledSink"),
            "the legacy keys stay frozen"
        );
    }

    #[test]
    fn a_null_key_reads_as_absent() {
        let state = json!({ "lastSuccessfulPort": null, "ledCalibration": null });
        assert!(strips_from_legacy(state.as_object().unwrap()).is_empty());
    }

    #[test]
    fn the_primary_strip_is_the_first_enabled_one() {
        let state = json!({
            "lastSuccessfulPort": "COM3",
            "lastWledSink": { "ip": "10.0.0.5", "port": 4048, "ledCount": 90, "protocol": "ddp" }
        });
        let primary = primary_strip(strips_from_legacy(state.as_object().unwrap()));
        assert!(matches!(
            primary.and_then(|strip| strip.transport),
            Some(StripTransport::Serial { port_name }) if port_name == "COM3"
        ));
        assert!(primary_strip(Vec::new()).is_none());
    }
}
