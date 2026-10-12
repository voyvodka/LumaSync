//! Test scenes: a full-screen window on the captured display, under the twin
//! and the popup, playing a scene that Ambilight captures — the app's own
//! stand-in for an Ambilight test video. A scene owns the lights while it
//! plays and gives them back when it stops: the mode it interrupted returns
//! with the settings as saved, and a user's mode change from anywhere ends the
//! scene and wins.
//!
//! The window is built and shown before Ambilight starts. On macOS the capture
//! leaves the whole app out during a session; the scene window is excepted,
//! and only once it is on screen, since ScreenCaptureKit lists no window that
//! is not. The page draws black until the session names its scene, which
//! happens after both.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime};

use super::session::{
    answer, emit_session, not_open, refusal, PreviewSession, PreviewSessionResult,
    PreviewSessionState, SceneSet,
};
use super::windows::{build_scene, next_scene_label, raise_over_scene, reuse_on_display};
use crate::commands::ambilight_capture;
use crate::commands::calibration::list_displays;
use crate::commands::lighting_mode::latency::LatencyResult;
use crate::commands::lighting_mode::preview_scene::{
    set_scene_brightness, start_scene_queued, stop_scene_queued, SceneLighting, SceneRestore,
};
use crate::commands::lighting_mode::LightingRuntimeState;
use crate::commands::status::CommandStatus;
use crate::events::PREVIEW_LATENCY_EVENT;

const PREVIEW_SCENE_STARTED: &str = "PREVIEW_SCENE_STARTED";
const PREVIEW_SCENE_STOPPED: &str = "PREVIEW_SCENE_STOPPED";
const PREVIEW_SCENE_UPDATED: &str = "PREVIEW_SCENE_UPDATED";
const PREVIEW_SCENE_NOT_RUNNING: &str = "PREVIEW_SCENE_NOT_RUNNING";
const PREVIEW_SCENE_NO_OUTPUT: &str = "PREVIEW_SCENE_NO_OUTPUT";
const PREVIEW_SCENE_CAPTURE_DENIED: &str = "PREVIEW_SCENE_CAPTURE_DENIED";
const PREVIEW_SCENE_START_FAILED: &str = "PREVIEW_SCENE_START_FAILED";
const PREVIEW_SCENE_TEST_PATTERN_ACTIVE: &str = "PREVIEW_SCENE_TEST_PATTERN_ACTIVE";
const PREVIEW_DISPLAY_NOT_FOUND: &str = "PREVIEW_DISPLAY_NOT_FOUND";
const PREVIEW_RESTORE_FAILED: &str = "PREVIEW_RESTORE_FAILED";

/// `SceneKind` in `src/shared/contracts/preview.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SceneKind {
    EdgeTour,
    Spiral,
    Sunset,
    ColorFields,
    Letterbox,
    Latency,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartPreviewScenePayload {
    pub kind: SceneKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPreviewSceneBrightnessPayload {
    pub brightness: f32,
}

/// `f` on the main thread, where windows are built, awaited. `Err` says why
/// it never ran.
async fn on_main<R, T, F>(app: &AppHandle<R>, f: F) -> Result<T, String>
where
    R: Runtime,
    T: Send + 'static,
    F: FnOnce(&AppHandle<R>) -> T + Send + 'static,
{
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(f(&handle));
    })
    .map_err(|error| format!("the main thread did not take the scene window: {error}"))?;
    receiver
        .await
        .map_err(|error| format!("the scene window build did not answer: {error}"))
}

/// The capture filter waits for ScreenCaptureKit, so off the async workers.
async fn except_from_exclusion(window: Option<u32>) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        ambilight_capture::set_capture_excepted_window(window);
    })
    .await;
}

/// The scene window goes and the session says no scene plays, at once: a
/// scene started right after finds no window to reuse and builds its own. The
/// lights are the caller's — restored by a stop, or already the user's after a
/// mode change. Blocks on the capture filter.
/// Hidden for the next scene rather than destroyed, as the twin is kept: a
/// destroyed webview window is never freed.
fn park_scene_window<R: Runtime>(app: &AppHandle<R>, state: &PreviewSessionState, label: String) {
    if let Some(window) = app.get_webview_window(&label) {
        match window.hide() {
            Ok(()) => state.set_idle_scene(label),
            Err(error) => {
                log::warn!("[preview] scene window {label} not hidden: {error}");
                let _ = window.destroy();
            }
        }
    }
}

fn take_down_scene_blocking<R: Runtime>(app: &AppHandle<R>) -> PreviewSession {
    let state = app.state::<PreviewSessionState>();
    let (label, session) = state.clear_scene();
    if let Some(label) = label {
        park_scene_window(app, &state, label);
    }
    ambilight_capture::set_capture_excepted_window(None);
    emit_session(app);
    session
}

async fn take_down_scene<R: Runtime>(app: &AppHandle<R>) -> PreviewSession {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || take_down_scene_blocking(&handle))
        .await
        .unwrap_or(PreviewSession::Closed)
}

/// A start that did not take: why, in the popup's codes.
fn scene_start_failure(status: CommandStatus) -> (&'static str, &'static str, Option<String>) {
    let details = Some(format!(
        "{}: {} {}",
        status.code,
        status.message,
        status.details.as_deref().unwrap_or_default()
    ));
    let denied = status
        .details
        .as_deref()
        .is_some_and(|d| d.contains("AMBILIGHT_CAPTURE_PERMISSION_DENIED"));
    if denied {
        (
            PREVIEW_SCENE_CAPTURE_DENIED,
            "Screen recording is not allowed, so Ambilight cannot see the scene.",
            details,
        )
    } else {
        (
            PREVIEW_SCENE_START_FAILED,
            "Ambilight could not start for the scene.",
            details,
        )
    }
}

/// Play `kind`: the scene window over the captured display, then Ambilight on
/// the user's settings for it. With a scene already playing it switches in
/// place, keeping the mode the first one interrupted.
#[tauri::command]
pub async fn start_preview_scene<R: Runtime>(
    app: AppHandle<R>,
    payload: StartPreviewScenePayload,
) -> Result<PreviewSessionResult, String> {
    let state = app.state::<PreviewSessionState>();
    let Some(target) = state.scene_target()? else {
        return Ok(not_open());
    };
    if app.state::<LightingRuntimeState>().test_pattern_active() {
        return Ok(refusal(
            target.session,
            PREVIEW_SCENE_TEST_PATTERN_ACTIVE,
            "A test pattern is running; stop it first.",
            None,
        ));
    }

    if target.scene_label.is_none() {
        let displays = list_displays(app.clone()).unwrap_or_default();
        let Some(display) = displays.into_iter().find(|d| d.id == target.display_id) else {
            return Ok(refusal(
                target.session,
                PREVIEW_DISPLAY_NOT_FOUND,
                "The display the preview is on is gone.",
                Some(target.display_id),
            ));
        };
        let idle = state.take_idle_scene();
        let reused = idle.clone();
        let over_scene = target.over_scene.clone();
        // The kept window when it is still there; a fresh label otherwise, since
        // a label stays reserved until its destroy completes.
        let built = on_main(&app, move |app| {
            let built = match idle.and_then(|label| app.get_webview_window(&label)) {
                Some(window) => reuse_on_display(&window, &display).map(|()| {
                    #[cfg(target_os = "macos")]
                    let number = crate::macos_window::window_number(&window);
                    #[cfg(not(target_os = "macos"))]
                    let number = None;
                    (window.label().to_string(), number)
                }),
                None => {
                    let label = next_scene_label();
                    build_scene(app, &label, &display).map(|(_, number)| (label, number))
                }
            };
            if built.is_ok() {
                raise_over_scene(app, &over_scene);
            }
            built
        })
        .await
        .and_then(|built| built);
        let (label, number) = match built {
            Ok(built) => built,
            Err(reason) => {
                if let Some(label) = reused {
                    park_scene_window(&app, &state, label);
                }
                return Ok(refusal(
                    target.session,
                    PREVIEW_SCENE_START_FAILED,
                    "The scene window could not be opened.",
                    Some(reason),
                ));
            }
        };
        if !state.adopt_scene_window(&label)? {
            park_scene_window(&app, &state, label);
            return Ok(not_open());
        }
        except_from_exclusion(number).await;
    }

    // Past here a window is up: no way out may leave it over the display.
    let outcome = match start_scene_queued(app.clone(), payload.kind).await {
        Ok(outcome) => outcome,
        Err(error) => {
            take_down_scene(&app).await;
            return Err(error);
        }
    };
    let failed = match outcome {
        SceneLighting::Running { brightness } => {
            return match state.set_scene(payload.kind, brightness)? {
                SceneSet::Playing(session) => {
                    emit_session(&app);
                    Ok(answer(session, PREVIEW_SCENE_STARTED, "Scene started."))
                }
                SceneSet::Superseded(session) => {
                    emit_session(&app);
                    Ok(answer(
                        session,
                        PREVIEW_SCENE_NOT_RUNNING,
                        "A mode change took the lights before the scene started.",
                    ))
                }
                // The session ended while Ambilight started, and found no
                // scene yet to give the lights back from.
                SceneSet::Closed => {
                    stop_scene_queued(app.clone()).await?;
                    Ok(not_open())
                }
            };
        }
        SceneLighting::TestPatternActive => (
            PREVIEW_SCENE_TEST_PATTERN_ACTIVE,
            "A test pattern is running; stop it first.",
            None,
        ),
        SceneLighting::NoOutput => (
            PREVIEW_SCENE_NO_OUTPUT,
            "No strip, WLED panel or Hue stream to light.",
            None,
        ),
        SceneLighting::Failed(status) => scene_start_failure(status),
    };
    let session = take_down_scene(&app).await;
    let (code, message, details) = failed;
    Ok(refusal(session, code, message, details))
}

/// Stop the scene: the mode it interrupted comes back, then its window goes.
#[tauri::command]
pub async fn stop_preview_scene<R: Runtime>(
    app: AppHandle<R>,
) -> Result<PreviewSessionResult, String> {
    let restore = stop_scene_queued(app.clone()).await;
    let session = take_down_scene(&app).await;
    Ok(match restore? {
        SceneRestore::Restored => answer(session, PREVIEW_SCENE_STOPPED, "Scene stopped."),
        SceneRestore::Off(status) => refusal(
            session,
            PREVIEW_RESTORE_FAILED,
            "The lights could not go back to their mode.",
            Some(format!("{}: {}", status.code, status.message)),
        ),
        SceneRestore::NotRunning if matches!(session, PreviewSession::Closed) => not_open(),
        SceneRestore::NotRunning => answer(session, PREVIEW_SCENE_NOT_RUNNING, "No scene plays."),
    })
}

/// The scene's brightness, live; never saved, since the scene is not the
/// user's mode. Outside 0..1 it is clamped.
#[tauri::command]
pub async fn set_preview_scene_brightness<R: Runtime>(
    app: AppHandle<R>,
    payload: SetPreviewSceneBrightnessPayload,
) -> Result<PreviewSessionResult, String> {
    let brightness = if payload.brightness.is_finite() {
        payload.brightness.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let lighting_app = app.clone();
    let applied = tauri::async_runtime::spawn_blocking(move || {
        set_scene_brightness(&lighting_app.state::<LightingRuntimeState>(), brightness)
    })
    .await
    .map_err(|error| {
        format!("LIGHTING_TRANSITION_WORKER_FAILED: the brightness change died: {error}")
    })?;
    let state = app.state::<PreviewSessionState>();
    let updated = if applied {
        state.set_scene_brightness(brightness)?
    } else {
        None
    };
    if applied {
        // The popup holds a dragged value only while the drag lasts; after it,
        // the session's is the one it shows.
        emit_session(&app);
        super::feed::refresh(&app);
    }
    Ok(match updated {
        Some(session) => answer(session, PREVIEW_SCENE_UPDATED, "Scene brightness changed."),
        None => match state.scene_target()? {
            Some(target) => answer(target.session, PREVIEW_SCENE_NOT_RUNNING, "No scene plays."),
            None => not_open(),
        },
    })
}

/// One latency sample's result, to the popup. From the worker thread.
pub fn send_latency<R: Runtime>(app: &AppHandle<R>, result: &LatencyResult) {
    let Some(popup) = app
        .try_state::<PreviewSessionState>()
        .and_then(|state| state.popup_label())
    else {
        return;
    };
    if let Err(error) = app.emit_to(
        EventTarget::webview_window(popup.as_str()),
        PREVIEW_LATENCY_EVENT,
        result,
    ) {
        log::warn!("[preview] latency not sent to {popup}: {error}");
    }
}

/// A user's mode change ended the scene; the lights are already theirs. Run
/// in that change's turn of the mode-change queue, so a scene start queued
/// behind it finds the session without one.
pub fn scene_superseded<R: Runtime>(app: &AppHandle<R>) {
    take_down_scene_blocking(app);
}

/// The session ended with a scene playing: the lights go back to the mode it
/// interrupted, in the mode-change queue. Its window goes with the session's.
pub(super) fn stop_scene_lights_later<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = stop_scene_queued(handle.clone()).await {
            log::warn!("[preview] the lights did not come back after the scene: {error}");
        }
        except_from_exclusion(None).await;
    });
}

/// The scene window went away on its own.
pub(super) fn scene_window_lost<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = stop_scene_queued(handle.clone()).await {
            log::warn!("[preview] the lights did not come back after the scene: {error}");
        }
        take_down_scene(&handle).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capture_refused_by_the_os_says_so() {
        let denied = CommandStatus::new(
            "AMBILIGHT_MODE_START_FAILED",
            "Ambilight runtime could not start.",
            Some("AMBILIGHT_CAPTURE_PERMISSION_DENIED: SCShareableContent".to_string()),
        );
        assert_eq!(scene_start_failure(denied).0, PREVIEW_SCENE_CAPTURE_DENIED);

        let other = CommandStatus::new(
            "AMBILIGHT_MODE_START_FAILED",
            "Ambilight runtime could not start.",
            Some("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND".to_string()),
        );
        let (code, _, details) = scene_start_failure(other);
        assert_eq!(code, PREVIEW_SCENE_START_FAILED);
        assert!(details
            .unwrap()
            .contains("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND"));
    }
}
