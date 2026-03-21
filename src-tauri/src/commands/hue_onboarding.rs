use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommandStatus {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueBridgeSummary {
    pub id: String,
    pub ip: String,
    pub name: String,
    pub model_id: Option<String>,
    pub software_version: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueDiscoveryResponse {
    pub status: CommandStatus,
    pub bridges: Vec<HueBridgeSummary>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueVerifyBridgeIpResponse {
    pub status: CommandStatus,
    pub bridge: Option<HueBridgeSummary>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HuePairingCredentials {
    pub username: String,
    pub client_key: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HuePairBridgeResponse {
    pub status: CommandStatus,
    pub credentials: Option<HuePairingCredentials>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueValidateCredentialsResponse {
    pub status: CommandStatus,
    pub valid: bool,
}

pub fn parse_discovery_payload(_payload: &str) -> HueDiscoveryResponse {
    HueDiscoveryResponse {
        status: command_status("HUE_DISCOVERY_FAILED", "TODO", None),
        bridges: Vec::new(),
    }
}

pub fn verify_hue_bridge_ip_input(ip: &str) -> HueVerifyBridgeIpResponse {
    HueVerifyBridgeIpResponse {
        status: command_status(
            "HUE_IP_VALID",
            "TODO",
            Some(format!("{ip} accepted in placeholder")),
        ),
        bridge: None,
    }
}

pub fn parse_pairing_payload(_payload: &str) -> HuePairBridgeResponse {
    HuePairBridgeResponse {
        status: command_status("HUE_PAIRING_FAILED", "TODO", None),
        credentials: None,
    }
}

pub fn parse_credentials_validation_payload(_payload: &str) -> HueValidateCredentialsResponse {
    HueValidateCredentialsResponse {
        status: command_status("HUE_CREDENTIAL_CHECK_FAILED", "TODO", None),
        valid: false,
    }
}

fn command_status(code: &str, message: &str, details: Option<String>) -> CommandStatus {
    CommandStatus {
        code: code.to_string(),
        message: message.to_string(),
        details,
    }
}
