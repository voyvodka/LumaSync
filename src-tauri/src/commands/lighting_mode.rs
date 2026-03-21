use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum LightingModeKind {
    Off,
    Ambilight,
    Solid,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SolidColorPayload {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub brightness: f32,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AmbilightPayload {
    pub brightness: f32,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LightingModeConfig {
    pub kind: LightingModeKind,
    pub solid: Option<SolidColorPayload>,
    pub ambilight: Option<AmbilightPayload>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightingCommandStatus {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightingModeCommandResult {
    pub active: bool,
    pub mode: LightingModeConfig,
    pub status: LightingCommandStatus,
}

fn apply_mode_change_for_test(
    _current: LightingModeConfig,
    _next: LightingModeConfig,
) -> LightingModeCommandResult {
    todo!("implemented in green phase")
}

#[cfg(test)]
mod tests {
    use super::{
        apply_mode_change_for_test, AmbilightPayload, LightingModeConfig, LightingModeKind,
        SolidColorPayload,
    };

    fn ambilight_mode() -> LightingModeConfig {
        LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            solid: None,
            ambilight: Some(AmbilightPayload { brightness: 0.8 }),
        }
    }

    fn solid_mode() -> LightingModeConfig {
        LightingModeConfig {
            kind: LightingModeKind::Solid,
            solid: Some(SolidColorPayload {
                r: 32,
                g: 64,
                b: 128,
                brightness: 0.6,
            }),
            ambilight: None,
        }
    }

    #[test]
    fn set_ambilight_stops_previous_then_starts_new_runtime() {
        let result = apply_mode_change_for_test(solid_mode(), ambilight_mode());

        assert_eq!(result.status.code, "AMBILIGHT_MODE_STARTED");
        assert_eq!(result.mode.kind, LightingModeKind::Ambilight);
        assert!(result.active);
    }

    #[test]
    fn set_solid_applies_payload_and_marks_mode_active() {
        let result = apply_mode_change_for_test(ambilight_mode(), solid_mode());

        assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
        assert_eq!(result.mode.kind, LightingModeKind::Solid);
        assert!(result.active);
    }

    #[test]
    fn repeated_switches_keep_single_active_runtime() {
        let first = apply_mode_change_for_test(solid_mode(), ambilight_mode());
        let second = apply_mode_change_for_test(first.mode, solid_mode());

        assert_eq!(second.status.code, "SOLID_MODE_APPLIED");
        assert_eq!(second.mode.kind, LightingModeKind::Solid);
    }
}
