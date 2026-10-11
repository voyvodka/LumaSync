//! The preview session. Opening it builds the popup and the twin and hides the
//! main window; it changes no light. Every way out — `close_preview`, the
//! popup or twin going away, the tray's rescue — runs `end_session`, which
//! destroys every preview window there is and brings the main window back if
//! the session hid it.
//!
//! The lock is never held across a window call: a destroy can deliver the
//! window's `Destroyed` event before it returns, and that event runs
//! `end_session` again. On Windows a window build pumps messages, so a second
//! `open_preview` can arrive mid-build; the `opening` flag turns it away.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime, State};

use super::exclusion;
use super::feed::TwinFeed;
use super::scene::SceneKind;
use super::windows::{
    app_in_front, build_popup, build_twin, float_over_full_screen, is_preview_window,
    next_popup_label, next_twin_label, reuse_on_display, reuse_popup,
};
use crate::commands::calibration::{list_displays, DisplayInfoPayload};
use crate::commands::shell_state;
use crate::commands::status::CommandStatus;
use crate::events::PREVIEW_SESSION_EVENT;

const PREVIEW_OPENED: &str = "PREVIEW_OPENED";
const PREVIEW_ALREADY_OPEN: &str = "PREVIEW_ALREADY_OPEN";
const PREVIEW_CLOSED: &str = "PREVIEW_CLOSED";
pub(super) const PREVIEW_NOT_OPEN: &str = "PREVIEW_NOT_OPEN";
const PREVIEW_POPUP_UPDATED: &str = "PREVIEW_POPUP_UPDATED";
const PREVIEW_TWIN_UPDATED: &str = "PREVIEW_TWIN_UPDATED";
const PREVIEW_OPEN_FAILED: &str = "PREVIEW_OPEN_FAILED";
const PREVIEW_CLOSE_FAILED: &str = "PREVIEW_CLOSE_FAILED";

/// `PreviewSession` in `src/shared/contracts/preview.ts`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum PreviewSession {
    Closed,
    #[serde(rename_all = "camelCase")]
    Live {
        display_id: String,
        popup_hidden: bool,
        twin_hidden: bool,
        /// Shown or not by the user, the twin is off screen while Ambilight
        /// captures where nothing can keep it out of the capture.
        twin_held_for_capture: bool,
    },
    /// Live, with a scene playing and Ambilight running for it.
    #[serde(rename_all = "camelCase")]
    Scene {
        display_id: String,
        popup_hidden: bool,
        twin_hidden: bool,
        twin_held_for_capture: bool,
        scene: SceneKind,
        /// The scene's own brightness, never saved.
        scene_brightness: f32,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSessionResult {
    pub session: PreviewSession,
    pub status: CommandStatus,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPreviewPopupHiddenPayload {
    pub hidden: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPreviewTwinHiddenPayload {
    pub hidden: bool,
}

struct OpenSession {
    display_id: String,
    twin_label: String,
    popup_label: String,
    popup_hidden: bool,
    /// The user's switch; never saved, so every session opens with the twin.
    twin_hidden: bool,
    /// Set only when opening hid a visible main window, so a session opened
    /// from the tray with the shell already hidden does not conjure it on the
    /// way out.
    main_hidden_by_session: bool,
    /// The app the user was last in: the one in front when the session opened
    /// — a full-screen film, say — or one they went to since, on this Space or
    /// another. It gets focus back on close, so the user stays where they are.
    return_to: Option<i32>,
    /// Whether the app runs as an accessory yet (`float_over_full_screen`).
    /// Opened from inside the app it stays a Dock app until the user goes to
    /// another one: the switch deactivates an active app, and macOS hands focus
    /// to the next app in line, which pulls the user to that app's Space when
    /// it is full screen.
    floating: bool,
    /// The scene window, from its build until it is destroyed.
    scene_label: Option<String>,
    /// What plays once Ambilight runs for it.
    scene: Option<PlayingScene>,
}

#[derive(Clone, Copy)]
struct PlayingScene {
    kind: SceneKind,
    brightness: f32,
}

/// What `start_preview_scene` needs from the open session.
pub(super) struct SceneTarget {
    pub display_id: String,
    pub scene_label: Option<String>,
    /// The windows the scene must stay under.
    pub over_scene: Vec<String>,
    pub session: PreviewSession,
}

impl OpenSession {
    #[cfg(any(target_os = "macos", test))]
    fn shown_labels(&self) -> Vec<String> {
        let mut labels = Vec::new();
        if !self.twin_hidden {
            labels.push(self.twin_label.clone());
        }
        if !self.popup_hidden {
            labels.push(self.popup_label.clone());
        }
        labels
    }

    fn wire(&self) -> PreviewSession {
        let display_id = self.display_id.clone();
        let twin_held_for_capture = exclusion::twin_held_for_capture();
        match self.scene {
            Some(scene) => PreviewSession::Scene {
                display_id,
                popup_hidden: self.popup_hidden,
                twin_hidden: self.twin_hidden,
                twin_held_for_capture,
                scene: scene.kind,
                scene_brightness: scene.brightness,
            },
            None => PreviewSession::Live {
                display_id,
                popup_hidden: self.popup_hidden,
                twin_hidden: self.twin_hidden,
                twin_held_for_capture,
            },
        }
    }

    /// The windows that hear `preview://session`: the popup, and the scene
    /// window, which draws the scene the session names.
    fn listeners(&self) -> Vec<String> {
        let mut labels = vec![self.popup_label.clone()];
        labels.extend(self.scene_label.clone());
        labels
    }
}

#[derive(Default)]
struct Inner {
    open: Option<OpenSession>,
    opening: bool,
    /// The last session's twin and popup, hidden for the next one to reuse.
    idle: Option<IdleWindows>,
    /// The last scene's window, hidden for the next scene to reuse.
    idle_scene: Option<String>,
}

#[derive(Clone)]
struct IdleWindows {
    twin_label: String,
    popup_label: String,
}

impl IdleWindows {
    fn holds(&self, label: &str) -> bool {
        label == self.twin_label || label == self.popup_label
    }
}

/// What `set_scene` found.
pub(super) enum SceneSet {
    Playing(PreviewSession),
    /// A mode change took the lights and the window before the scene was
    /// recorded; the lights are the user's.
    Superseded(PreviewSession),
    Closed,
}

/// Tauri-managed session state. `twin_open` lives outside the mutex so the
/// worker's per-frame gate reads it without the lock; it means a twin has
/// subscribed to its frames, not merely that its window exists.
pub struct PreviewSessionState {
    inner: Mutex<Inner>,
    twin_open: Arc<AtomicBool>,
    pub(super) feed: TwinFeed,
}

impl Default for PreviewSessionState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            twin_open: Arc::new(AtomicBool::new(false)),
            feed: TwinFeed::default(),
        }
    }
}

impl PreviewSessionState {
    fn lock(&self) -> Result<MutexGuard<'_, Inner>, String> {
        self.inner
            .lock()
            .map_err(|error| format!("PREVIEW_SESSION_LOCK_FAILED: {error}"))
    }

    /// The gate each worker reads per frame: with it off the worker builds no
    /// twin frame at all.
    pub fn twin_open(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.twin_open)
    }

    pub(super) fn display_id(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.open.as_ref().map(|open| open.display_id.clone()))
    }

    /// The twin's label and whether the user hid it. Best-effort: a poisoned
    /// lock answers `None` rather than wedging a caller.
    pub(super) fn twin_visibility(&self) -> Option<(String, bool)> {
        self.inner.lock().ok().and_then(|inner| {
            inner
                .open
                .as_ref()
                .map(|open| (open.twin_label.clone(), open.twin_hidden))
        })
    }

    /// The windows to tell, and what to tell them.
    pub(super) fn listeners_and_session(&self) -> Option<(Vec<String>, PreviewSession)> {
        self.inner.lock().ok().and_then(|inner| {
            inner
                .open
                .as_ref()
                .map(|open| (open.listeners(), open.wire()))
        })
    }

    pub(super) fn popup_label(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.open.as_ref().map(|open| open.popup_label.clone()))
    }

    pub(super) fn scene_target(&self) -> Result<Option<SceneTarget>, String> {
        let inner = self.lock()?;
        Ok(inner.open.as_ref().map(|open| SceneTarget {
            display_id: open.display_id.clone(),
            scene_label: open.scene_label.clone(),
            over_scene: vec![open.twin_label.clone(), open.popup_label.clone()],
            session: open.wire(),
        }))
    }

    /// Records the scene window just built. `false` when the session ended
    /// during the build: the window is the caller's to destroy.
    pub(super) fn adopt_scene_window(&self, label: &str) -> Result<bool, String> {
        let mut inner = self.lock()?;
        let Some(open) = inner.open.as_mut() else {
            return Ok(false);
        };
        open.scene_label = Some(label.to_string());
        Ok(true)
    }

    /// The scene's lights are up; record it as playing — unless its window is
    /// gone, because the session ended or a mode change took the lights in
    /// between.
    pub(super) fn set_scene(&self, kind: SceneKind, brightness: f32) -> Result<SceneSet, String> {
        let mut inner = self.lock()?;
        let Some(open) = inner.open.as_mut() else {
            return Ok(SceneSet::Closed);
        };
        if open.scene_label.is_none() {
            return Ok(SceneSet::Superseded(open.wire()));
        }
        open.scene = Some(PlayingScene { kind, brightness });
        Ok(SceneSet::Playing(open.wire()))
    }

    pub(super) fn set_scene_brightness(
        &self,
        brightness: f32,
    ) -> Result<Option<PreviewSession>, String> {
        let mut inner = self.lock()?;
        let Some(scene) = inner.open.as_mut().and_then(|open| open.scene.as_mut()) else {
            return Ok(None);
        };
        scene.brightness = brightness;
        Ok(inner.open.as_ref().map(OpenSession::wire))
    }

    /// The scene is over: its window's label, for the caller to destroy, and
    /// the session as it is now.
    pub(super) fn clear_scene(&self) -> (Option<String>, PreviewSession) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match inner.open.as_mut() {
            Some(open) => {
                open.scene = None;
                (open.scene_label.take(), open.wire())
            }
            None => (None, PreviewSession::Closed),
        }
    }

    pub(super) fn is_scene_window(&self, label: &str) -> bool {
        self.inner.lock().ok().is_some_and(|inner| {
            inner
                .open
                .as_ref()
                .is_some_and(|open| open.scene_label.as_deref() == Some(label))
        })
    }

    // Every write of the gate happens under the session lock, so a show, a
    // subscribe and a drop cannot interleave into a gate open with no channel
    // or shut with one.

    /// Registers the twin's channel and opens the feed gate, in the same
    /// critical section that checks the caller is the open session's twin: an
    /// ending session cannot slip between the check and the gate. A twin the
    /// user hid subscribes with the gate shut.
    pub(super) fn subscribe_twin(
        &self,
        label: &str,
        channel: tauri::ipc::Channel,
    ) -> Result<bool, String> {
        let inner = self.lock()?;
        let Some(open) = inner.open.as_ref().filter(|open| open.twin_label == label) else {
            return Ok(false);
        };
        self.feed.subscribe(label.to_string(), channel);
        self.twin_open.store(!open.twin_hidden, Ordering::SeqCst);
        Ok(true)
    }

    pub(super) fn drop_twin_subscriber(&self) {
        let _inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        self.twin_open.store(false, Ordering::SeqCst);
        self.feed.clear();
    }

    /// Hidden, the worker builds no twin frame; shown, the gate opens again if
    /// the twin has subscribed. `None` with no session open.
    fn set_twin_hidden(&self, hidden: bool) -> Result<Option<PreviewSession>, String> {
        let mut inner = self.lock()?;
        let Some(open) = inner.open.as_mut() else {
            return Ok(None);
        };
        open.twin_hidden = hidden;
        self.twin_open
            .store(!hidden && self.feed.has_subscriber(), Ordering::SeqCst);
        Ok(Some(open.wire()))
    }

    fn commit(&self, open: OpenSession) -> Result<PreviewSession, String> {
        let wire = open.wire();
        let mut inner = self.lock()?;
        inner.open = Some(open);
        inner.opening = false;
        Ok(wire)
    }

    /// Another app came to the front while the session is open. Answers the
    /// windows to bring over to its Space when this is what turns the app into
    /// an accessory.
    #[cfg(any(target_os = "macos", test))]
    fn note_front_app(&self, pid: i32) -> Option<Vec<String>> {
        let mut inner = self.inner.lock().ok()?;
        let open = inner.open.as_mut()?;
        open.return_to = Some(pid);
        if open.floating {
            return None;
        }
        open.floating = true;
        Some(open.shown_labels())
    }

    fn take_idle(&self) -> Option<IdleWindows> {
        self.inner.lock().ok()?.idle.take()
    }

    pub(super) fn take_idle_scene(&self) -> Option<String> {
        self.inner.lock().ok()?.idle_scene.take()
    }

    pub(super) fn set_idle_scene(&self, label: String) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.idle_scene = Some(label);
        }
    }

    fn set_idle(&self, idle: IdleWindows) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.idle = Some(idle);
        }
    }

    fn take(&self) -> Result<Option<OpenSession>, String> {
        let mut inner = self.lock()?;
        let taken = inner.open.take();
        self.twin_open.store(false, Ordering::SeqCst);
        self.feed.clear();
        Ok(taken)
    }

    /// `open_preview` needs real monitors, which `MockRuntime` does not have;
    /// this records a session the way it does.
    #[cfg(test)]
    pub(crate) fn open_for_test(&self, display_id: &str, twin_label: &str, popup_label: &str) {
        let _ = self.commit(OpenSession {
            display_id: display_id.into(),
            twin_label: twin_label.into(),
            popup_label: popup_label.into(),
            popup_hidden: false,
            twin_hidden: false,
            main_hidden_by_session: false,
            return_to: None,
            floating: false,
            scene_label: None,
            scene: None,
        });
    }

    /// A scene as `start_preview_scene` records it, without its window and lights.
    #[cfg(test)]
    pub(crate) fn play_scene_for_test(&self, kind: SceneKind, brightness: f32) {
        if let Ok(mut inner) = self.lock() {
            if let Some(open) = inner.open.as_mut() {
                open.scene_label.get_or_insert_with(|| {
                    format!("{}test", super::windows::LED_PREVIEW_SCENE_LABEL_PREFIX)
                });
            }
        }
        let _ = self.set_scene(kind, brightness);
    }

    /// What `subscribe_twin_frames` does, without the window it needs.
    #[cfg(test)]
    pub(crate) fn subscribe_for_test(&self, label: &str, channel: tauri::ipc::Channel) {
        self.feed.subscribe(label.into(), channel);
        self.twin_open.store(true, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub(crate) fn twin_layout_for_test(&self) -> Option<super::feed::TwinLayout> {
        self.feed.layout_for_test()
    }

    #[cfg(test)]
    pub(crate) fn close_for_test(&self) {
        let _ = self.take();
    }
}

/// Clears `opening` on every way out of `open_preview`, early returns included.
struct OpeningGuard<'a>(&'a PreviewSessionState);

impl Drop for OpeningGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.0.inner.lock() {
            inner.opening = false;
        }
    }
}

fn result(session: PreviewSession, code: &str, message: &str) -> PreviewSessionResult {
    PreviewSessionResult {
        session,
        status: CommandStatus::ok(code, message),
    }
}

fn failure(code: &str, message: &str, details: String) -> PreviewSessionResult {
    PreviewSessionResult {
        session: PreviewSession::Closed,
        status: CommandStatus::new(code, message, Some(details)),
    }
}

/// Where Ambilight captures: the saved display, else the primary, else the
/// first — the order the capture itself falls back in.
fn resolve_display(
    displays: &[DisplayInfoPayload],
    saved: Option<&str>,
) -> Option<DisplayInfoPayload> {
    saved
        .and_then(|id| displays.iter().find(|d| d.id == id))
        .or_else(|| displays.iter().find(|d| d.is_primary))
        .or_else(|| displays.first())
        .cloned()
}

fn hide_main<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(main) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) else {
        return false;
    };
    if !matches!(main.is_visible(), Ok(true)) {
        return false;
    }
    let hidden = main.hide().is_ok();
    crate::commands::window_visibility::refresh(app);
    hidden
}

/// Back where it was. Opened from inside the app, the main window takes focus
/// again; opened over another app — a full-screen film from the tray — focus
/// goes back to that app and the main window only reappears on its own Space,
/// so the user is not pulled away from where they were.
fn restore_main<R: Runtime>(app: &AppHandle<R>, return_to: Option<i32>) {
    let Some(main) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) else {
        return;
    };
    match return_to {
        #[cfg(target_os = "macos")]
        Some(_) => crate::macos_window::order_front_without_focus(&main),
        _ => {
            let _ = main.show();
            let _ = main.unminimize();
            let _ = main.set_focus();
        }
    }
    crate::commands::window_visibility::refresh(app);
}

/// Before the app turns back into a Dock app: as the active app, that turn
/// would pull the user to the main window's Space.
fn hand_back(return_to: Option<i32>) {
    #[cfg(target_os = "macos")]
    if let Some(pid) = return_to {
        crate::macos_window::activate_app(pid);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = return_to;
}

/// To the popup only: the twin learns its layout on its own event, and the
/// main window learns the session ended by being shown again. Sent from the
/// main thread with the session as it is then, not as the caller saw it: two
/// changes on two threads can ask in either order, and the last event the
/// popup gets must be the current state.
pub(super) fn emit_session<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let posted = app.run_on_main_thread(move || {
        let Some((labels, session)) = handle
            .try_state::<PreviewSessionState>()
            .and_then(|state| state.listeners_and_session())
        else {
            return;
        };
        for label in labels {
            if let Err(error) = handle.emit_to(
                EventTarget::webview_window(label.as_str()),
                PREVIEW_SESSION_EVENT,
                &session,
            ) {
                log::warn!("[preview] session not sent to {label}: {error}");
            }
        }
    });
    if let Err(error) = posted {
        log::warn!("[preview] session event not posted: {error}");
    }
}

fn reveal_popup<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(popup) = app.get_webview_window(label) {
        let _ = popup.unminimize();
        let _ = popup.show();
        let _ = popup.set_focus();
    }
}

/// The kept pair back for this session, on `display`. Either one gone or
/// failing to come back, both are destroyed and a new pair is built.
fn reuse_idle<R: Runtime>(
    app: &AppHandle<R>,
    idle: &IdleWindows,
    display: &DisplayInfoPayload,
) -> bool {
    let twin = app.get_webview_window(&idle.twin_label);
    let popup = app.get_webview_window(&idle.popup_label);
    let reused = match (&twin, &popup) {
        (Some(twin), Some(popup)) => reuse_on_display(twin, display)
            .and_then(|()| reuse_popup(popup))
            .map_err(|reason| log::warn!("[preview] kept windows not reused: {reason}"))
            .is_ok(),
        _ => false,
    };
    if !reused {
        let mut failures = Vec::new();
        destroy(app, &idle.twin_label, &mut failures);
        destroy(app, &idle.popup_label, &mut failures);
    }
    reused
}

/// `true` once the window is off screen.
fn hide<R: Runtime>(app: &AppHandle<R>, label: &str) -> bool {
    app.get_webview_window(label)
        .is_some_and(|window| window.hide().is_ok())
}

fn destroy<R: Runtime>(app: &AppHandle<R>, label: &str, failures: &mut Vec<String>) {
    if let Some(window) = app.get_webview_window(label) {
        if let Err(error) = window.destroy() {
            failures.push(format!("{label}: {error}"));
        }
    }
}

/// Every preview window there is but the pair kept for the next session: one
/// stranded by an earlier failed destroy or open goes too. A surviving twin is
/// click-through and undecorated, so nothing on screen could dismiss it.
fn destroy_preview_windows<R: Runtime>(
    app: &AppHandle<R>,
    kept: Option<&IdleWindows>,
    idle_scene: Option<&String>,
) -> (usize, Vec<String>) {
    let labels: Vec<String> = app
        .webview_windows()
        .into_keys()
        .filter(|label| is_preview_window(label) && !kept.is_some_and(|kept| kept.holds(label)))
        .filter(|label| !idle_scene.is_some_and(|scene| scene == label))
        .collect();
    let mut failures = Vec::new();
    for label in &labels {
        destroy(app, label, &mut failures);
    }
    (labels.len(), failures)
}

/// Open the session: the twin over the captured display, the popup, and the
/// main window out of the way. Already open ⇒ the popup comes back.
#[tauri::command]
pub fn open_preview<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PreviewSessionState>,
) -> Result<PreviewSessionResult, String> {
    {
        let mut inner = state.lock()?;
        if let Some(open) = inner.open.as_mut() {
            open.popup_hidden = false;
            let (label, session) = (open.popup_label.clone(), open.wire());
            drop(inner);
            reveal_popup(&app, &label);
            emit_session(&app);
            return Ok(result(
                session,
                PREVIEW_ALREADY_OPEN,
                "The preview is already open.",
            ));
        }
        if inner.opening {
            return Ok(result(
                PreviewSession::Closed,
                PREVIEW_ALREADY_OPEN,
                "The preview is opening.",
            ));
        }
        inner.opening = true;
    }
    let _opening = OpeningGuard(state.inner());

    let displays = match list_displays(app.clone()) {
        Ok(displays) => displays,
        Err(reason) => {
            return Ok(failure(
                PREVIEW_OPEN_FAILED,
                "Could not read the displays.",
                reason,
            ))
        }
    };
    let saved = shell_state::persisted(&app).and_then(|s| s.selected_display_id());
    let Some(display) = resolve_display(&displays, saved.as_deref()) else {
        return Ok(failure(
            PREVIEW_OPEN_FAILED,
            "No display to show the preview on.",
            "no display was enumerated".to_string(),
        ));
    };

    // Before any preview window exists, so none is ever in a frame; and the
    // main window out of the way first, or the popup taking focus pulls macOS
    // over to the main window's Space instead of the one the user is in.
    exclusion::session_opening();
    let return_to = app_in_front();
    let main_hidden_by_session = hide_main(&app);
    // Opened over another app the app is not active, so the switch moves no
    // one; opened from inside, it waits for `on_other_app_activated`.
    let floating = return_to.is_some();
    if floating {
        float_over_full_screen(&app, true);
    }
    let reused = state
        .take_idle()
        .filter(|idle| reuse_idle(&app, idle, &display));
    let (twin_label, popup_label) = match reused {
        Some(idle) => (idle.twin_label, idle.popup_label),
        None => {
            let twin_label = next_twin_label();
            if let Err(reason) = build_twin(&app, &twin_label, &display) {
                exclusion::session_ended();
                hand_back(return_to);
                float_over_full_screen(&app, false);
                if main_hidden_by_session {
                    restore_main(&app, return_to);
                }
                return Ok(failure(
                    PREVIEW_OPEN_FAILED,
                    "Could not open the LED twin.",
                    reason,
                ));
            }
            let popup_label = next_popup_label();
            if let Err(reason) = build_popup(&app, &popup_label) {
                let mut failures = Vec::new();
                destroy(&app, &twin_label, &mut failures);
                exclusion::session_ended();
                hand_back(return_to);
                float_over_full_screen(&app, false);
                if main_hidden_by_session {
                    restore_main(&app, return_to);
                }
                failures.insert(0, reason);
                return Ok(failure(
                    PREVIEW_OPEN_FAILED,
                    "Could not open the preview controls.",
                    failures.join("; "),
                ));
            }
            (twin_label, popup_label)
        }
    };

    let committed = state.commit(OpenSession {
        display_id: display.id,
        twin_label: twin_label.clone(),
        popup_label: popup_label.clone(),
        popup_hidden: false,
        twin_hidden: false,
        main_hidden_by_session,
        return_to,
        floating,
        scene_label: None,
        scene: None,
    });
    match committed {
        Ok(session) => {
            exclusion::session_opened(&app);
            Ok(result(session, PREVIEW_OPENED, "Preview opened."))
        }
        Err(error) => {
            let mut failures = Vec::new();
            destroy(&app, &twin_label, &mut failures);
            destroy(&app, &popup_label, &mut failures);
            exclusion::session_ended();
            hand_back(return_to);
            float_over_full_screen(&app, false);
            if main_hidden_by_session {
                restore_main(&app, return_to);
            }
            Err(error)
        }
    }
}

/// End the session from wherever it is. Safe to call again: a second call
/// finds nothing open, and still clears any preview window left behind.
pub fn end_session<R: Runtime>(app: &AppHandle<R>) -> Result<PreviewSessionResult, String> {
    let open = match app.try_state::<PreviewSessionState>() {
        Some(state) => state.take()?,
        None => None,
    };
    // Queued behind any mode change in flight, never restored inline: a
    // transition from here would block the thread a window close runs on.
    if open
        .as_ref()
        .is_some_and(|open| open.scene.is_some() || open.scene_label.is_some())
    {
        super::scene::stop_scene_lights_later(app);
    }
    // The session's twin and popup are hidden for the next one; a pair that
    // cannot be hidden whole is destroyed with the strays.
    let state = app.try_state::<PreviewSessionState>();
    let previously_idle = state.as_ref().and_then(|state| state.take_idle());
    let kept = open
        .as_ref()
        .map(|open| IdleWindows {
            twin_label: open.twin_label.clone(),
            popup_label: open.popup_label.clone(),
        })
        .or(previously_idle)
        .filter(|kept| hide(app, &kept.twin_label) && hide(app, &kept.popup_label));
    let idle_scene = state.as_ref().and_then(|state| {
        let label = open
            .as_ref()
            .and_then(|open| open.scene_label.clone())
            .or_else(|| state.take_idle_scene())?;
        hide(app, &label).then_some(label)
    });
    let (swept, failures) = destroy_preview_windows(app, kept.as_ref(), idle_scene.as_ref());
    if let (Some(state), Some(label)) = (state.as_ref(), idle_scene) {
        state.set_idle_scene(label);
    }
    if let (Some(state), Some(kept)) = (state.as_ref(), kept) {
        state.set_idle(kept);
    }
    let return_to = open.as_ref().and_then(|open| open.return_to);
    hand_back(return_to);
    if open.is_some() || swept > 0 {
        float_over_full_screen(app, false);
    }
    // A window that outlived its destroy stays out of the capture.
    if failures.is_empty() {
        exclusion::session_ended();
    }
    if open
        .as_ref()
        .is_some_and(|open| open.main_hidden_by_session)
    {
        restore_main(app, return_to);
    }

    if !failures.is_empty() {
        let details = failures.join("; ");
        log::error!("[preview] a window outlived the session: {details}");
        return Ok(failure(
            PREVIEW_CLOSE_FAILED,
            "A preview window could not be closed.",
            details,
        ));
    }
    if open.is_none() && swept == 0 {
        return Ok(result(
            PreviewSession::Closed,
            PREVIEW_NOT_OPEN,
            "No preview is open.",
        ));
    }
    Ok(result(
        PreviewSession::Closed,
        PREVIEW_CLOSED,
        "Preview closed.",
    ))
}

#[tauri::command]
pub fn close_preview<R: Runtime>(app: AppHandle<R>) -> Result<PreviewSessionResult, String> {
    end_session(&app)
}

/// What the popup reads on mount; `preview://session` brings it each change after.
#[tauri::command]
pub fn get_preview_session(
    state: State<'_, PreviewSessionState>,
) -> Result<PreviewSession, String> {
    Ok(state
        .lock()?
        .open
        .as_ref()
        .map_or(PreviewSession::Closed, OpenSession::wire))
}

/// Hide or show the twin while the session stays open. Shown again, it is
/// sent a fresh frame at once rather than the one it last drew. Async for that
/// refresh, which waits on the lighting lock.
#[tauri::command]
pub async fn set_preview_twin_hidden<R: Runtime>(
    app: AppHandle<R>,
    payload: SetPreviewTwinHiddenPayload,
) -> Result<PreviewSessionResult, String> {
    let updated = match app.try_state::<PreviewSessionState>() {
        Some(state) => state.set_twin_hidden(payload.hidden)?,
        None => None,
    };
    let Some(session) = updated else {
        return Ok(result(
            PreviewSession::Closed,
            PREVIEW_NOT_OPEN,
            "No preview is open.",
        ));
    };
    exclusion::sync_twin_visibility(&app);
    emit_session(&app);
    if !payload.hidden {
        let refresh_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || super::feed::refresh(&refresh_app))
            .await
            .map_err(|error| {
                format!("PREVIEW_SESSION_LOCK_FAILED: the twin refresh died: {error}")
            })?;
    }
    Ok(result(session, PREVIEW_TWIN_UPDATED, "LED twin updated."))
}

#[tauri::command]
pub fn set_preview_popup_hidden<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PreviewSessionState>,
    payload: SetPreviewPopupHiddenPayload,
) -> Result<PreviewSessionResult, String> {
    let (popup_label, session) = {
        let mut inner = state.lock()?;
        let Some(open) = inner.open.as_mut() else {
            return Ok(result(
                PreviewSession::Closed,
                PREVIEW_NOT_OPEN,
                "No preview is open.",
            ));
        };
        open.popup_hidden = payload.hidden;
        (open.popup_label.clone(), open.wire())
    };
    if payload.hidden {
        if let Some(popup) = app.get_webview_window(&popup_label) {
            let _ = popup.hide();
        }
    } else {
        reveal_popup(&app, &popup_label);
    }
    emit_session(&app);
    Ok(result(
        session,
        PREVIEW_POPUP_UPDATED,
        "Preview controls updated.",
    ))
}

/// The user went to another app during the session — clicked it, or moved to
/// its Space. It becomes the app that gets focus back on close, and a session
/// opened from inside the app turns into an accessory now, while it is not
/// active, so its windows can follow onto a full-screen Space.
#[cfg(target_os = "macos")]
pub(super) fn on_other_app_activated<R: Runtime>(app: &AppHandle<R>, pid: i32) {
    let Some(raise) = app
        .try_state::<PreviewSessionState>()
        .and_then(|state| state.note_front_app(pid))
    else {
        return;
    };
    float_over_full_screen(app, true);
    // Queued behind the policy change, which the event loop applies in order;
    // windows already up are not moved onto a full-screen Space by it alone.
    let handle = app.clone();
    let posted = app.run_on_main_thread(move || {
        for label in raise {
            if let Some(window) = handle.get_webview_window(&label) {
                crate::macos_window::order_front_regardless(&window);
            }
        }
    });
    if let Err(error) = posted {
        log::warn!("[preview] preview windows not raised after the app went accessory: {error}");
    }
}

/// A popup or twin that goes away on its own — the popup's close, a display
/// unplugged under the twin — ends the session it belonged to, so the other
/// window is not stranded and the main window comes back. Matched by label,
/// which no second window gets, so a destroyed window from an earlier session
/// dying late cannot end the current one. Skipped while quitting: bringing the
/// main window back would only flash it.
pub fn on_session_window_destroyed<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if crate::shutdown::in_progress() {
        return;
    }
    let Some(state) = app.try_state::<PreviewSessionState>() else {
        return;
    };
    // The scene going away alone — its display unplugged — ends the scene, not
    // the session.
    if state.is_scene_window(label) {
        super::scene::scene_window_lost(app);
        return;
    }
    let belongs = state
        .inner
        .lock()
        .ok()
        .and_then(|inner| {
            inner
                .open
                .as_ref()
                .map(|open| label == open.popup_label || label == open.twin_label)
        })
        .unwrap_or(false);
    if belongs {
        if let Err(error) = end_session(app) {
            log::warn!("[preview] ending the session after {label} closed failed: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(id: &str, primary: bool) -> DisplayInfoPayload {
        DisplayInfoPayload {
            id: id.into(),
            label: id.into(),
            width: 1920,
            height: 1080,
            x: 0,
            y: 0,
            is_primary: primary,
            scale_factor: 1.0,
        }
    }

    #[test]
    fn the_twin_goes_where_the_capture_falls_back_to() {
        let displays = [display("a", false), display("b", true)];
        assert_eq!(resolve_display(&displays, Some("a")).unwrap().id, "a");
        assert_eq!(resolve_display(&displays, Some("gone")).unwrap().id, "b");
        assert_eq!(resolve_display(&displays, None).unwrap().id, "b");
        assert_eq!(
            resolve_display(&[display("a", false)], None).unwrap().id,
            "a"
        );
        assert!(resolve_display(&[], None).is_none());
    }

    /// The worker builds twin frames only while a twin has subscribed, and an
    /// ending session takes the subscription with it.
    #[test]
    fn the_gate_opens_on_subscribe_and_closes_with_the_session() {
        let state = PreviewSessionState::default();
        let gate = state.twin_open();
        state.open_for_test("a", "led-twin-overlay-7", "led-control-popup-7");
        assert!(
            !gate.load(Ordering::Relaxed),
            "a window alone feeds nothing"
        );
        assert_eq!(
            state.twin_visibility(),
            Some(("led-twin-overlay-7".to_string(), false))
        );
        state.feed.subscribe(
            "led-twin-overlay-7".into(),
            tauri::ipc::Channel::new(|_| Ok(())),
        );
        gate.store(true, Ordering::SeqCst);
        state.close_for_test();
        assert!(!gate.load(Ordering::Relaxed));
        assert_eq!(state.twin_visibility(), None);
    }

    /// A twin the user hid that reloads and subscribes again stays unfed.
    #[test]
    fn a_hidden_twin_subscribes_with_the_gate_shut() {
        let state = PreviewSessionState::default();
        state.open_for_test("a", "led-twin-overlay-5", "led-control-popup-5");
        state.set_twin_hidden(true).unwrap();

        let ours = state
            .subscribe_twin("led-twin-overlay-5", tauri::ipc::Channel::new(|_| Ok(())))
            .unwrap();

        assert!(ours);
        assert!(!state.twin_open().load(Ordering::SeqCst));
    }

    #[test]
    fn a_second_end_finds_nothing_open() {
        let app = tauri::test::mock_app();
        app.manage(PreviewSessionState::default());
        app.state::<PreviewSessionState>().open_for_test(
            "a",
            "led-twin-overlay-1",
            "led-control-popup-1",
        );
        let first = end_session(app.handle()).unwrap();
        assert_eq!(first.status.code, PREVIEW_CLOSED);
        let second = end_session(app.handle()).unwrap();
        assert_eq!(second.status.code, PREVIEW_NOT_OPEN);
    }

    /// A twin left by an earlier failure is not the session's, and nothing on
    /// screen can dismiss it; the next ending clears it all the same.
    #[test]
    fn ending_clears_a_preview_window_no_session_owns() {
        let app = tauri::test::mock_app();
        app.manage(PreviewSessionState::default());
        tauri::WebviewWindowBuilder::new(&app, "led-twin-overlay-99", Default::default())
            .build()
            .expect("stray twin");
        tauri::WebviewWindowBuilder::new(&app, crate::MAIN_WINDOW_LABEL, Default::default())
            .build()
            .expect("main");

        let ended = end_session(app.handle()).unwrap();

        // CLOSED, not NOT_OPEN: with no session the sweep is what found it.
        // MockRuntime defers the registry removal, so the window is not
        // looked up afterwards.
        assert_eq!(ended.status.code, PREVIEW_CLOSED);
        assert!(app.get_webview_window(crate::MAIN_WINDOW_LABEL).is_some());
    }

    /// Closing keeps the session's twin and popup for the next one instead of
    /// destroying them — a destroyed webview window is never freed — while a
    /// stray from an earlier failure still goes.
    #[test]
    fn ending_keeps_the_sessions_pair_for_the_next_one() {
        let app = tauri::test::mock_app();
        app.manage(PreviewSessionState::default());
        for label in ["led-twin-overlay-4", "led-control-popup-4"] {
            tauri::WebviewWindowBuilder::new(&app, label, Default::default())
                .build()
                .expect("a session window");
        }
        let state = app.state::<PreviewSessionState>();
        state.open_for_test("a", "led-twin-overlay-4", "led-control-popup-4");

        let ended = end_session(app.handle()).unwrap();

        assert_eq!(ended.status.code, PREVIEW_CLOSED);
        assert!(app.get_webview_window("led-twin-overlay-4").is_some());
        assert!(app.get_webview_window("led-control-popup-4").is_some());
        let idle = state.take_idle().expect("the pair is kept");
        assert_eq!(
            (idle.twin_label.as_str(), idle.popup_label.as_str()),
            ("led-twin-overlay-4", "led-control-popup-4")
        );
    }

    /// A mode change that takes the lights mid-start takes the scene's window
    /// too; the start that then records the scene must not claim it plays.
    #[test]
    fn a_scene_whose_window_went_is_not_recorded_as_playing() {
        let state = PreviewSessionState::default();
        assert!(matches!(
            state.set_scene(SceneKind::Spiral, 1.0),
            Ok(SceneSet::Closed)
        ));
        state.open_for_test("a", "led-twin-overlay-5", "led-control-popup-5");
        assert!(state.adopt_scene_window("led-preview-scene-5").unwrap());
        assert!(matches!(
            state.set_scene(SceneKind::Spiral, 1.0),
            Ok(SceneSet::Playing(PreviewSession::Scene { .. }))
        ));

        let _ = state.clear_scene();
        let superseded = state.set_scene(SceneKind::Sunset, 1.0);

        assert!(matches!(
            superseded,
            Ok(SceneSet::Superseded(PreviewSession::Live { .. }))
        ));
    }

    /// The Windows build pump can deliver a second open mid-build; it must not
    /// build a second twin that the first open's commit would orphan.
    #[test]
    fn an_open_arriving_mid_open_builds_nothing() {
        let app = tauri::test::mock_app();
        app.manage(PreviewSessionState::default());
        let state = app.state::<PreviewSessionState>();
        state.lock().unwrap().opening = true;

        let second = open_preview(app.handle().clone(), state).unwrap();

        assert_eq!(second.status.code, PREVIEW_ALREADY_OPEN);
        assert!(app
            .webview_windows()
            .keys()
            .all(|label| !is_preview_window(label)));
    }

    /// Closing hands focus to the app the user went to last, and only the
    /// first move away turns an in-app session into an accessory.
    #[test]
    fn the_last_app_the_user_went_to_is_the_one_focus_returns_to() {
        let state = PreviewSessionState::default();
        assert_eq!(state.note_front_app(41), None, "no session, nothing noted");

        state.open_for_test("a", "led-twin-overlay-3", "led-control-popup-3");
        assert_eq!(
            state.note_front_app(41),
            Some(vec![
                "led-twin-overlay-3".to_string(),
                "led-control-popup-3".to_string()
            ])
        );
        assert_eq!(state.note_front_app(42), None, "already an accessory");
        let open = state.lock().unwrap();
        assert_eq!(open.open.as_ref().and_then(|open| open.return_to), Some(42));
    }

    #[test]
    fn a_hidden_twin_stays_hidden_when_the_app_goes_accessory() {
        let state = PreviewSessionState::default();
        state.open_for_test("a", "led-twin-overlay-4", "led-control-popup-4");
        state.lock().unwrap().open.as_mut().unwrap().twin_hidden = true;
        assert_eq!(
            state.note_front_app(7),
            Some(vec!["led-control-popup-4".to_string()])
        );
    }

    #[test]
    fn a_hidden_popup_stays_hidden_when_the_app_goes_accessory() {
        let state = PreviewSessionState::default();
        state.open_for_test("a", "led-twin-overlay-4", "led-control-popup-4");
        state.lock().unwrap().open.as_mut().unwrap().popup_hidden = true;
        assert_eq!(
            state.note_front_app(7),
            Some(vec!["led-twin-overlay-4".to_string()])
        );
    }

    #[test]
    fn the_session_wire_shape_is_tagged_by_state() {
        assert_eq!(
            serde_json::to_value(PreviewSession::Closed).unwrap(),
            serde_json::json!({ "state": "closed" })
        );
        assert_eq!(
            serde_json::to_value(PreviewSession::Live {
                display_id: "a".into(),
                popup_hidden: true,
                twin_hidden: false,
                twin_held_for_capture: false,
            })
            .unwrap(),
            serde_json::json!({
                "state": "live",
                "displayId": "a",
                "popupHidden": true,
                "twinHidden": false,
                "twinHeldForCapture": false
            })
        );
    }
}
