//! Forgetting the paired bridge. Hue leaves the lighting through the lighting
//! transaction, the saved selection loses `hue`, the saved pairing leaves the
//! shell state, and the pair leaves the keychain. See docs/architecture/hue.md
//! ("Forgetting a bridge").

use log::{info, warn};
use tauri::{AppHandle, Runtime};

use super::super::lighting_mode::outputs::{
    apply_outputs_with, cancel_boot_hue_waits, release_hue_with, ApplyOutputsRequest,
    LightingOrigin,
};
use super::super::lighting_mode::snapshot::OutputTarget;
use super::super::shell_state::{self, PersistedShellState};
use super::super::status::CommandStatus;
use super::bridge_identity::normalize_bridge_id;
use super::credential_store::{default_store, forget_pair_for_bridge, PairForget, SecretStore};
use super::health;
use super::state_store::HueRuntimeTriggerSource;

/// Everything the shell state holds about the paired bridge. The room map's
/// Hue channels and zones are the user's layout and stay, as does
/// `hueOffBehavior`, a preference about Off rather than about this bridge.
pub(crate) const HUE_BRIDGE_STATE_KEYS: &[&str] = &[
    "lastHueBridge",
    "lastHueAreaId",
    "hueBridgeSyncedPositions",
    "hueAppKey",
    "hueClientKey",
    "hueCredentialStatus",
    "hueOnboardingStep",
    "credentialStorageBackend",
];

/// Sole constructor for this command's status, so the contract verifier can
/// harvest its codes from one call shape.
fn forget_status(code: &str, message: &str, details: Option<String>) -> CommandStatus {
    CommandStatus {
        code: code.to_string(),
        message: message.to_string(),
        details,
    }
}

fn same_bridge(a: &str, b: &str) -> bool {
    match (normalize_bridge_id(a), normalize_bridge_id(b)) {
        (Some(a), Some(b)) => a == b,
        _ => a.eq_ignore_ascii_case(b),
    }
}

/// The body of `forget_hue_bridge`, with the secret store passed in.
pub(crate) async fn forget_hue_bridge_with<R: Runtime>(
    app: &AppHandle<R>,
    bridge_id: &str,
    store: &dyn SecretStore,
) -> CommandStatus {
    let saved = shell_state::persisted(app);
    if let Some(saved_id) = saved
        .as_ref()
        .and_then(PersistedShellState::saved_hue_bridge_id)
    {
        if !same_bridge(&saved_id, bridge_id) {
            return forget_status(
                "HUE_FORGET_FAILED",
                "The Hue bridge was not forgotten.",
                Some("The saved bridge is a different one; nothing was changed.".to_string()),
            );
        }
    }

    cancel_boot_hue_waits(app, "the bridge was forgotten");
    let mut notes: Vec<String> = Vec::new();
    match release_hue_with(app, HueRuntimeTriggerSource::DeviceSurface).await {
        Ok(result) if result.outcome.stop_failed.contains(&OutputTarget::Hue) => {
            notes.push("the Hue stream did not confirm its stop".to_string());
        }
        Ok(_) => {}
        Err(error) => {
            return forget_status(
                "HUE_FORGET_FAILED",
                "The Hue bridge was not forgotten.",
                Some(format!(
                    "Hue could not be taken out of the lighting: {error}"
                )),
            );
        }
    }

    // A user's choice, so the transaction saves it and keeps its own record
    // of the saved selection in step.
    if let Some(targets) = saved
        .as_ref()
        .and_then(PersistedShellState::last_output_targets)
        .filter(|targets| targets.iter().any(|target| target == "hue"))
    {
        let rest: Vec<String> = targets.into_iter().filter(|t| t != "hue").collect();
        let request = ApplyOutputsRequest {
            mode: None,
            targets: Some(rest),
            origin: LightingOrigin::User,
        };
        match apply_outputs_with(app, request).await {
            Ok(result) => info!(
                "[hue-forget] saved selection without Hue: {}",
                result.status.code
            ),
            Err(error) => notes.push(format!("the output selection was not saved: {error}")),
        }
    }

    if let Err(error) = shell_state::remove_from_rust(app, HUE_BRIDGE_STATE_KEYS) {
        warn!("[hue-forget] saved pairing not cleared: {error}");
        return forget_status(
            "HUE_FORGET_FAILED",
            "The Hue bridge was not forgotten.",
            Some(format!("The saved pairing could not be cleared: {error}")),
        );
    }
    health::note_settings_saved(app, HUE_BRIDGE_STATE_KEYS.iter().copied());

    if let PairForget::Failed(reason) = forget_pair_for_bridge(store, bridge_id) {
        notes.push(format!(
            "the key could not be deleted from the keychain: {reason}"
        ));
    }

    if notes.is_empty() {
        info!("[hue-forget] bridge forgotten");
        forget_status("HUE_FORGET_OK", "The Hue bridge was forgotten.", None)
    } else {
        warn!("[hue-forget] bridge forgotten, but {}", notes.join("; "));
        forget_status(
            "HUE_FORGET_PARTIAL",
            "The Hue bridge was forgotten, with something left over.",
            Some(notes.join("; ")),
        )
    }
}

/// Forget the paired bridge: stop Hue through the lighting transaction, drop
/// `hue` from the saved outputs, clear the saved pairing, and delete the key
/// pair when it is this bridge's. The bridge keeps LumaSync in its list of
/// authorised apps; CLIP v2 has no call to remove it.
#[tauri::command]
pub async fn forget_hue_bridge<R: Runtime>(
    app: AppHandle<R>,
    bridge_id: String,
) -> Result<CommandStatus, String> {
    let store = default_store();
    Ok(forget_hue_bridge_with(&app, &bridge_id, store.as_ref()).await)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tauri::async_runtime::block_on;

    use super::super::super::lighting_mode::outputs::apply_outputs_with;
    use super::super::super::lighting_mode::{
        LightingModeConfig, LightingModeKind, Rig, RigSetup, SolidColorPayload,
    };
    use super::super::credential_store::tests::InMemoryStore;
    use super::super::credential_store::{
        KeychainStore, KEY_HUE_APP_KEY, KEY_HUE_BRIDGE_ID, KEY_HUE_CLIENT_KEY,
    };
    use super::*;

    const BRIDGE: &str = "abc";

    fn solid() -> LightingModeConfig {
        LightingModeConfig {
            kind: LightingModeKind::Solid,
            solid: Some(SolidColorPayload {
                r: 1,
                g: 20,
                b: 30,
                brightness: 1.0,
            }),
            ..LightingModeConfig::default()
        }
    }

    fn rig(targets: &[&str]) -> Rig {
        let rig = Rig::new(RigSetup {
            state: json!({
                "credentialStorageBackend": "keychain",
                "hueCredentialStatus": "valid",
                "hueOnboardingStep": "ready",
                "hueBridgeSyncedPositions": { "area-1": [{ "channelId": 0, "positionX": 0.1, "positionY": 0.8 }] },
                "hueOffBehavior": "restore",
                "roomMap": { "hueChannels": [{ "channelIndex": 0, "x": 0.1, "y": 0.8, "z": 0.0 }], "zones": [] },
            }),
            ..RigSetup::default()
        });
        let started = block_on(apply_outputs_with(
            &rig.handle(),
            ApplyOutputsRequest {
                mode: Some(solid()),
                targets: Some(targets.iter().map(|t| t.to_string()).collect()),
                origin: LightingOrigin::User,
            },
        ))
        .expect("apply resolves");
        assert_eq!(started.status.code, "OUTPUTS_APPLIED", "setup: {started:?}");
        rig.log.clear();
        rig
    }

    fn paired_store() -> InMemoryStore {
        let store = InMemoryStore::default();
        store.set(KEY_HUE_APP_KEY, "kc-user").unwrap();
        store.set(KEY_HUE_CLIENT_KEY, "kc-key").unwrap();
        store
    }

    fn forget(rig: &Rig, bridge_id: &str, store: &dyn SecretStore) -> CommandStatus {
        block_on(forget_hue_bridge_with(&rig.handle(), bridge_id, store))
    }

    #[test]
    fn forgetting_stops_hue_through_the_transaction_and_clears_the_pairing() {
        let rig = rig(&["usb", "hue"]);
        let store = paired_store();

        let status = forget(&rig, &BRIDGE.to_uppercase(), &store);

        assert_eq!(status.code, "HUE_FORGET_OK", "{status:?}");
        let hue_events: Vec<String> = rig
            .log
            .events()
            .into_iter()
            .filter(|event| event.starts_with("hue:"))
            .collect();
        assert_eq!(hue_events, vec!["hue:stop:device_surface"]);
        let snapshot = rig.state().snapshot.read();
        assert_eq!(
            snapshot.mode.kind,
            LightingModeKind::Solid,
            "the strip keeps running"
        );
        assert_eq!(snapshot.active_targets, vec![OutputTarget::Usb]);
        assert_eq!(rig.saved("lastOutputTargets"), Some(json!(["usb"])));
        for key in HUE_BRIDGE_STATE_KEYS {
            assert_eq!(rig.saved(key), None, "{key} left behind");
        }
        assert_eq!(rig.saved("hueOffBehavior"), Some(json!("restore")));
        assert!(
            rig.saved("roomMap")
                .is_some_and(|room| room["hueChannels"][0]["x"] == json!(0.1)),
            "room-map placements are the user's layout"
        );
        for slot in [KEY_HUE_APP_KEY, KEY_HUE_CLIENT_KEY, KEY_HUE_BRIDGE_ID] {
            assert_eq!(
                store.get(slot).unwrap(),
                None,
                "{slot} left in the keychain"
            );
        }
    }

    #[test]
    fn forgetting_the_only_output_ends_the_mode_and_saves_no_outputs() {
        let rig = rig(&["hue"]);
        let store = paired_store();

        let status = forget(&rig, BRIDGE, &store);

        assert_eq!(status.code, "HUE_FORGET_OK", "{status:?}");
        assert_eq!(rig.state().snapshot.read().mode.kind, LightingModeKind::Off);
        assert!(rig
            .log
            .events()
            .contains(&"hue:stop:device_surface".to_string()));
        assert_eq!(rig.saved("lastOutputTargets"), Some(json!([])));
        assert_eq!(rig.state().snapshot.read().selected_targets, vec![]);
    }

    #[test]
    fn another_saved_bridge_is_left_entirely_alone() {
        let rig = rig(&["usb", "hue"]);
        let store = paired_store();

        let status = forget(&rig, "some-other-bridge", &store);

        assert_eq!(status.code, "HUE_FORGET_FAILED");
        assert!(rig.log.events().is_empty(), "{:?}", rig.log.events());
        assert!(rig.saved("lastHueBridge").is_some());
        assert_eq!(rig.saved("lastOutputTargets"), Some(json!(["usb", "hue"])));
        assert_eq!(
            store.get(KEY_HUE_APP_KEY).unwrap().as_deref(),
            Some("kc-user")
        );
    }

    #[test]
    fn a_keychain_that_refuses_the_delete_makes_the_forget_partial() {
        let rig = rig(&["usb", "hue"]);

        let status = forget(&rig, BRIDGE, &KeychainStore::new());

        assert_eq!(status.code, "HUE_FORGET_PARTIAL");
        assert!(status.details.unwrap_or_default().contains("keychain"));
        assert_eq!(
            rig.saved("lastHueBridge"),
            None,
            "the saved pairing still goes"
        );
    }
}
