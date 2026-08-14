//! Channel-aware update checks.
//!
//! The plugin's own `check` command builds its updater from `tauri.conf.json`,
//! whose endpoint list is fixed at compile time. Picking a feed per user means
//! calling `UpdaterBuilder::endpoints` ourselves, which is Rust-only — so the
//! resolved `Update` never reaches JS and the install has to live here too.
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Resolves through `/releases/latest`, which GitHub defines as the newest
/// release that is neither a draft nor a prerelease.
const STABLE_ENDPOINT: &str =
    "https://github.com/voyvodka/LumaSync/releases/latest/download/latest.json";

/// A fixed anchor release, because GitHub has no "latest prerelease" URL.
/// `docs/architecture/build-and-release.md` explains how it is published.
const BETA_ENDPOINT: &str =
    "https://github.com/voyvodka/LumaSync/releases/download/beta-channel/latest-beta.json";

const PROGRESS_EVENT: &str = "updater://download-progress";

/// The update a successful check resolved, waiting for an install call.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterCommandStatus {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

impl UpdaterCommandStatus {
    fn new(code: &str, message: &str, details: Option<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            details,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResponse {
    pub status: UpdaterCommandStatus,
    pub channel: String,
    pub update: Option<UpdateMetadata>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallResponse {
    pub status: UpdaterCommandStatus,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadProgress {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    finished: bool,
}

/// Read `updateChannel` from the shell store, mirroring the other
/// `hydrate_*`/`read_persisted_*` readers. Anything unrecognised is "stable" —
/// an unreadable store must never silently move someone onto prereleases.
pub fn read_update_channel<R: Runtime>(app: &AppHandle<R>) -> String {
    let resolved = (|| {
        let dir = app.path().app_data_dir().ok()?;
        let raw = std::fs::read_to_string(dir.join("shell-state.json")).ok()?;
        let root: serde_json::Value = serde_json::from_str(&raw).ok()?;
        let channel = root.get("shell-state")?.get("updateChannel")?.as_str()?;
        Some(channel.to_string())
    })();
    match resolved.as_deref() {
        Some("beta") => "beta".to_string(),
        _ => "stable".to_string(),
    }
}

fn endpoint_for(channel: &str) -> &'static str {
    match channel {
        "beta" => BETA_ENDPOINT,
        _ => STABLE_ENDPOINT,
    }
}

#[tauri::command]
pub async fn check_for_update<R: Runtime>(
    app: AppHandle<R>,
    pending: State<'_, PendingUpdate>,
) -> Result<UpdateCheckResponse, String> {
    let channel = read_update_channel(&app);
    let endpoint = endpoint_for(&channel);

    let url = match endpoint.parse() {
        Ok(url) => url,
        Err(e) => {
            return Ok(UpdateCheckResponse {
                status: UpdaterCommandStatus::new(
                    "UPDATER_ENDPOINT_INVALID",
                    "The update endpoint for this channel is not a valid URL.",
                    Some(format!("{endpoint} -- {e}")),
                ),
                channel,
                update: None,
            })
        }
    };

    let builder = match app.updater_builder().endpoints(vec![url]) {
        Ok(builder) => builder,
        Err(e) => {
            return Ok(UpdateCheckResponse {
                status: UpdaterCommandStatus::new(
                    "UPDATER_ENDPOINT_INVALID",
                    "The update endpoint for this channel was rejected.",
                    Some(e.to_string()),
                ),
                channel,
                update: None,
            })
        }
    };

    let updater = match builder.build() {
        Ok(updater) => updater,
        Err(e) => {
            return Ok(UpdateCheckResponse {
                status: UpdaterCommandStatus::new(
                    "UPDATER_CHECK_FAILED",
                    "The updater could not be initialised.",
                    Some(e.to_string()),
                ),
                channel,
                update: None,
            })
        }
    };

    log::info!("[updater] checking channel={channel} endpoint={endpoint}");

    match updater.check().await {
        Ok(Some(update)) => {
            let metadata = UpdateMetadata {
                version: update.version.clone(),
                current_version: update.current_version.clone(),
                body: update.body.clone(),
                date: update.date.map(|d| d.to_string()),
            };
            log::info!(
                "[updater] channel={channel} offers {} (running {})",
                metadata.version,
                metadata.current_version
            );
            if let Ok(mut slot) = pending.0.lock() {
                *slot = Some(update);
            }
            Ok(UpdateCheckResponse {
                status: UpdaterCommandStatus::new(
                    "UPDATER_UPDATE_AVAILABLE",
                    "A newer version is available.",
                    None,
                ),
                channel,
                update: Some(metadata),
            })
        }
        Ok(None) => {
            if let Ok(mut slot) = pending.0.lock() {
                *slot = None;
            }
            Ok(UpdateCheckResponse {
                status: UpdaterCommandStatus::new(
                    "UPDATER_UP_TO_DATE",
                    "This is the newest version on the selected channel.",
                    None,
                ),
                channel,
                update: None,
            })
        }
        Err(e) => Ok(UpdateCheckResponse {
            status: UpdaterCommandStatus::new(
                "UPDATER_CHECK_FAILED",
                "Could not reach the update feed.",
                Some(e.to_string()),
            ),
            channel,
            update: None,
        }),
    }
}

#[tauri::command]
pub async fn download_and_install_update<R: Runtime>(
    app: AppHandle<R>,
    pending: State<'_, PendingUpdate>,
) -> Result<UpdateInstallResponse, String> {
    // Taken, not borrowed: a std Mutex guard cannot be held across an await,
    // and an install attempt consumes the pending update either way.
    let update = pending.0.lock().ok().and_then(|mut slot| slot.take());
    let Some(update) = update else {
        return Ok(UpdateInstallResponse {
            status: UpdaterCommandStatus::new(
                "UPDATER_NO_PENDING_UPDATE",
                "No update has been resolved; run a check first.",
                None,
            ),
        });
    };

    let downloaded = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let chunk_app = app.clone();
    let chunk_downloaded = downloaded.clone();
    let finish_app = app.clone();

    let result = update
        .download_and_install(
            move |chunk_length, content_length| {
                let total = chunk_downloaded
                    .fetch_add(chunk_length as u64, std::sync::atomic::Ordering::Relaxed)
                    + chunk_length as u64;
                let _ = chunk_app.emit(
                    PROGRESS_EVENT,
                    UpdateDownloadProgress {
                        downloaded_bytes: total,
                        total_bytes: content_length,
                        finished: false,
                    },
                );
            },
            move || {
                let _ = finish_app.emit(
                    PROGRESS_EVENT,
                    UpdateDownloadProgress {
                        downloaded_bytes: 0,
                        total_bytes: None,
                        finished: true,
                    },
                );
            },
        )
        .await;

    match result {
        Ok(()) => Ok(UpdateInstallResponse {
            status: UpdaterCommandStatus::new(
                "UPDATER_INSTALL_STARTED",
                "The update was downloaded and handed to the installer.",
                None,
            ),
        }),
        Err(e) => {
            log::error!("[updater] install failed: {e}");
            Ok(UpdateInstallResponse {
                status: UpdaterCommandStatus::new(
                    "UPDATER_INSTALL_FAILED",
                    "The update could not be downloaded or verified.",
                    Some(e.to_string()),
                ),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{endpoint_for, BETA_ENDPOINT, STABLE_ENDPOINT};

    #[test]
    fn beta_channel_resolves_to_the_anchor_feed() {
        assert_eq!(endpoint_for("beta"), BETA_ENDPOINT);
    }

    /// Anything other than an exact "beta" must stay on stable — a corrupt or
    /// partially-written store must not move an install onto prereleases.
    #[test]
    fn every_other_value_resolves_to_stable() {
        for value in ["stable", "", "Beta", "BETA", "nightly", "beta "] {
            assert_eq!(endpoint_for(value), STABLE_ENDPOINT, "{value:?}");
        }
    }

    /// The stable endpoint must keep resolving through `/releases/latest`,
    /// which excludes prereleases — pointing it at a tag would ship whatever
    /// that tag holds to every install.
    #[test]
    fn stable_endpoint_goes_through_releases_latest() {
        assert!(
            STABLE_ENDPOINT.contains("/releases/latest/download/"),
            "{STABLE_ENDPOINT}"
        );
        assert!(
            !BETA_ENDPOINT.contains("/releases/latest/"),
            "{BETA_ENDPOINT}"
        );
    }

    #[test]
    fn both_endpoints_are_parseable_urls() {
        for endpoint in [STABLE_ENDPOINT, BETA_ENDPOINT] {
            let parsed: Result<tauri::Url, _> = endpoint.parse();
            assert!(parsed.is_ok(), "{endpoint} must parse");
        }
    }
}
