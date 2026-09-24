//! Channel-aware update checks.
//!
//! The plugin's own `check` command builds its updater from `tauri.conf.json`,
//! whose endpoint list is fixed at compile time. Picking a feed per user means
//! calling `UpdaterBuilder::endpoints` ourselves, which is Rust-only — so the
//! resolved `Update` never reaches JS and the install has to live here too.
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use super::shell_state;
use super::status::CommandStatus;
use crate::events::UPDATER_PROGRESS_EVENT;
use crate::MAIN_WINDOW_LABEL;

/// Resolves through `/releases/latest`, which GitHub defines as the newest
/// release that is neither a draft nor a prerelease.
const STABLE_ENDPOINT: &str =
    "https://github.com/voyvodka/LumaSync/releases/latest/download/latest.json";

/// A fixed anchor release, because GitHub has no "latest prerelease" URL.
/// `docs/architecture/build-and-release.md` explains how it is published.
const BETA_ENDPOINT: &str =
    "https://github.com/voyvodka/LumaSync/releases/download/beta-channel/latest-beta.json";

/// Every chunk used to be an event and every event an App re-render.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Decides which download chunks become a progress event: the first, one per
/// `PROGRESS_INTERVAL`, and the one that completes a known length.
struct ProgressThrottle {
    interval: Duration,
    last_emit: Option<Instant>,
}

impl ProgressThrottle {
    fn new(interval: Duration) -> Self {
        Self {
            interval,
            last_emit: None,
        }
    }

    fn should_emit(&mut self, now: Instant, downloaded: u64, total: Option<u64>) -> bool {
        let complete = total.is_some_and(|total| downloaded >= total);
        let due = self
            .last_emit
            .is_none_or(|last| now.duration_since(last) >= self.interval);
        if complete || due {
            self.last_emit = Some(now);
            return true;
        }
        false
    }
}

/// The update a successful check resolved, waiting for an install call.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

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
    pub status: CommandStatus,
    pub channel: String,
    pub update: Option<UpdateMetadata>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallResponse {
    pub status: CommandStatus,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadProgress {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    finished: bool,
}

/// `useAutoUpdater` in the main window is the only listener; overlay webviews
/// have no reason to wake per chunk.
fn emit_progress<R: Runtime>(app: &AppHandle<R>, progress: UpdateDownloadProgress) {
    let _ = app.emit_to(
        EventTarget::webview_window(MAIN_WINDOW_LABEL),
        UPDATER_PROGRESS_EVENT,
        progress,
    );
}

/// Anything unrecognised is "stable" — an unreadable store must never
/// silently move someone onto prereleases.
pub fn read_update_channel<R: Runtime>(app: &AppHandle<R>) -> String {
    let resolved = shell_state::persisted(app).and_then(|state| state.update_channel());
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
                status: CommandStatus::new(
                    "UPDATER_ENDPOINT_INVALID",
                    "The update endpoint for this channel is not a valid URL.",
                    Some(format!("{endpoint} -- {e}")),
                ),
                channel,
                update: None,
            })
        }
    };

    // Windows only: the plugin runs this, launches the installer and exits
    // the process itself, so the orderly shutdown has to happen inside it.
    let installer_app = app.clone();
    let builder = app
        .updater_builder()
        .on_before_exit(move || crate::shutdown::cleanup_before_installer(&installer_app));
    let builder = match builder.endpoints(vec![url]) {
        Ok(builder) => builder,
        Err(e) => {
            return Ok(UpdateCheckResponse {
                status: CommandStatus::new(
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
                status: CommandStatus::new(
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
                status: CommandStatus::new(
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
                status: CommandStatus::new(
                    "UPDATER_UP_TO_DATE",
                    "This is the newest version on the selected channel.",
                    None,
                ),
                channel,
                update: None,
            })
        }
        Err(e) => Ok(UpdateCheckResponse {
            status: CommandStatus::new(
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
            status: CommandStatus::new(
                "UPDATER_NO_PENDING_UPDATE",
                "No update has been resolved; run a check first.",
                None,
            ),
        });
    };

    let mut downloaded: u64 = 0;
    let mut throttle = ProgressThrottle::new(PROGRESS_INTERVAL);
    let chunk_app = app.clone();
    let finish_app = app.clone();

    let result = update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded += chunk_length as u64;
                if throttle.should_emit(Instant::now(), downloaded, content_length) {
                    emit_progress(
                        &chunk_app,
                        UpdateDownloadProgress {
                            downloaded_bytes: downloaded,
                            total_bytes: content_length,
                            finished: false,
                        },
                    );
                }
            },
            move || {
                emit_progress(
                    &finish_app,
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
        Ok(()) => {
            // Windows never gets here: its installer relaunches the app. On
            // macOS and Linux the bundle was replaced in place and nothing
            // would restart it — the modal sat on "Installing".
            log::info!("[updater] install complete, restarting");
            app.request_restart();
            Ok(UpdateInstallResponse {
                status: CommandStatus::new(
                    "UPDATER_INSTALL_STARTED",
                    "The update was installed; the app is restarting.",
                    None,
                ),
            })
        }
        Err(e) => {
            log::error!("[updater] install failed: {e}");
            Ok(UpdateInstallResponse {
                status: CommandStatus::new(
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
    use std::time::{Duration, Instant};

    use super::{endpoint_for, ProgressThrottle, BETA_ENDPOINT, STABLE_ENDPOINT};

    const MS: Duration = Duration::from_millis(1);

    /// A 30 MB bundle arrives in thousands of chunks; each one used to be an
    /// event and each event an App render.
    #[test]
    fn a_burst_of_chunks_emits_once_per_interval() {
        let start = Instant::now();
        let mut throttle = ProgressThrottle::new(100 * MS);
        let emitted: Vec<u64> = (0..1_000u64)
            .filter(|&i| {
                throttle.should_emit(
                    start + Duration::from_millis(i),
                    i * 1_000,
                    Some(10_000_000),
                )
            })
            .collect();
        assert_eq!(emitted, (0..1_000).step_by(100).collect::<Vec<_>>());
    }

    #[test]
    fn the_first_chunk_is_emitted_at_once() {
        let mut throttle = ProgressThrottle::new(100 * MS);
        assert!(throttle.should_emit(Instant::now(), 1, None));
    }

    /// The bar has to reach 100 % even when the last chunk lands inside the
    /// interval.
    #[test]
    fn the_completing_chunk_is_always_emitted() {
        let start = Instant::now();
        let mut throttle = ProgressThrottle::new(100 * MS);
        assert!(throttle.should_emit(start, 10, Some(100)));
        assert!(!throttle.should_emit(start + 5 * MS, 50, Some(100)));
        assert!(throttle.should_emit(start + 10 * MS, 100, Some(100)));
    }

    #[test]
    fn an_unknown_length_is_only_paced() {
        let start = Instant::now();
        let mut throttle = ProgressThrottle::new(100 * MS);
        assert!(throttle.should_emit(start, 10, None));
        assert!(!throttle.should_emit(start + 99 * MS, 20, None));
        assert!(throttle.should_emit(start + 100 * MS, 30, None));
    }

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
