//! The saved setup read as strips: one run of LEDs behind one local
//! controller, with the hardware, layout and correction that belong to it.
//! Until the saved state holds strips of its own they are derived from the
//! single-output keys, by the same rules as `stripsFromLegacy` in
//! `src/features/strips/model/legacyStrips.ts`; one fixture tests both.
//!
//! Values are carried as the JSON they were saved as and decoded where they
//! are read, so a field this build does not know survives the trip.

use serde_json::{Map, Value};

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
        enabled: true,
        transport,
        hardware,
        layout: layout.clone(),
        color_correction: color_correction.clone(),
    }];
    if let (Some(_), Some(sink)) = (serial, wled) {
        strips.push(LedStrip {
            id: second_id.to_owned(),
            enabled: false,
            transport: Some(StripTransport::Wled { sink }),
            hardware: StripHardware::default(),
            layout,
            color_correction,
        });
    }
    strips
}

/// The strip a setting with no strip named applies to: the first one enabled.
pub fn primary_strip(strips: Vec<LedStrip>) -> Option<LedStrip> {
    strips.into_iter().find(|strip| strip.enabled)
}

#[cfg(test)]
mod tests {
    use super::{primary_strip, strips_from_legacy, LedStrip, StripTransport};
    use serde_json::{json, Map, Value};

    const FIXTURE: &str = include_str!(
        "../../../src/features/strips/model/__tests__/fixtures/legacyStrips.parity.json"
    );

    fn strip_json(strip: &LedStrip) -> Value {
        let mut out = Map::new();
        out.insert("id".into(), json!(strip.id));
        out.insert("enabled".into(), json!(strip.enabled));
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
