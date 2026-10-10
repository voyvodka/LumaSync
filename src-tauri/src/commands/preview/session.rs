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
use tauri::{AppHandle, Manager, Runtime, State};

use super::exclusion;
use super::feed::TwinFeed;
use super::windows::{
    app_in_front, build_popup, build_twin, float_over_full_screen, is_preview_window,
    next_popup_label, next_twin_label,
};
use crate::commands::calibration::{list_displays, DisplayInfoPayload};
use crate::commands::shell_state;
use crate::commands::status::CommandStatus;

const PREVIEW_OPENED: &str = "PREVIEW_OPENED";
const PREVIEW_ALREADY_OPEN: &str = "PREVIEW_ALREADY_OPEN";
const PREVIEW_CLOSED: &str = "PREVIEW_CLOSED";
pub(super) const PREVIEW_NOT_OPEN: &str = "PREVIEW_NOT_OPEN";
const PREVIEW_POPUP_UPDATED: &str = "PREVIEW_POPUP_UPDATED";
const PREVIEW_OPEN_FAILED: &str = "PREVIEW_OPEN_FAILED";
const PREVIEW_CLOSE_FAILED: &str = "PREVIEW_CLOSE_FAILED";

/// `PreviewSession` in `src/shared/contracts/preview.ts`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum PreviewSession {
    Closed,
    #[serde(rename_all = "camelCase")]
    Live {
        display_id: String,
        popup_hidden: bool,
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

struct OpenSession {
    display_id: String,
    twin_label: String,
    popup_label: String,
    popup_hidden: bool,
    /// Set only when opening hid a visible main window, so a session opened
    /// from the tray with the shell already hidden does not conjure it on the
    /// way out.
    main_hidden_by_session: bool,
    /// The app the user was in when the session opened — a full-screen film,
    /// say — which gets focus back on close so the user stays where they were.
    return_to: Option<i32>,
}

impl OpenSession {
    fn wire(&self) -> PreviewSession {
        PreviewSession::Live {
            display_id: self.display_id.clone(),
            popup_hidden: self.popup_hidden,
        }
    }
}

#[derive(Default)]
struct Inner {
    open: Option<OpenSession>,
    opening: bool,
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

    /// The open session's twin. Best-effort: a poisoned lock answers `None`
    /// rather than wedging a caller.
    pub fn twin_label(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.open.as_ref().map(|open| open.twin_label.clone()))
    }

    pub(super) fn display_id(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.open.as_ref().map(|open| open.display_id.clone()))
    }

    pub(super) fn drop_twin_subscriber(&self) {
        self.twin_open.store(false, Ordering::SeqCst);
        self.feed.clear();
    }

    fn commit(&self, open: OpenSession) -> Result<PreviewSession, String> {
        let wire = open.wire();
        let mut inner = self.lock()?;
        inner.open = Some(open);
        inner.opening = false;
        Ok(wire)
    }

    fn take(&self) -> Result<Option<OpenSession>, String> {
        let taken = self.lock()?.open.take();
        self.drop_twin_subscriber();
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
            main_hidden_by_session: false,
            return_to: None,
        });
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

fn reveal_popup<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(popup) = app.get_webview_window(label) {
        let _ = popup.unminimize();
        let _ = popup.show();
        let _ = popup.set_focus();
    }
}

fn destroy<R: Runtime>(app: &AppHandle<R>, label: &str, failures: &mut Vec<String>) {
    if let Some(window) = app.get_webview_window(label) {
        if let Err(error) = window.destroy() {
            failures.push(format!("{label}: {error}"));
        }
    }
}

/// Every preview window there is, not only the open session's: one stranded by
/// an earlier failed destroy or open goes too. A surviving twin is
/// click-through and undecorated, so nothing on screen could dismiss it.
fn destroy_preview_windows<R: Runtime>(app: &AppHandle<R>) -> (usize, Vec<String>) {
    let labels: Vec<String> = app
        .webview_windows()
        .into_keys()
        .filter(|label| is_preview_window(label))
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
    float_over_full_screen(&app, true);
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

    let committed = state.commit(OpenSession {
        display_id: display.id,
        twin_label: twin_label.clone(),
        popup_label: popup_label.clone(),
        popup_hidden: false,
        main_hidden_by_session,
        return_to,
    });
    match committed {
        Ok(session) => {
            exclusion::session_opened(&app, &twin_label);
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
    let (swept, failures) = destroy_preview_windows(app);
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
    Ok(result(
        session,
        PREVIEW_POPUP_UPDATED,
        "Preview controls updated.",
    ))
}

/// A popup or twin that goes away on its own — the popup's close, a display
/// unplugged under the twin — ends the session it belonged to, so the other
/// window is not stranded and the main window comes back. Matched by label,
/// which is never reused, so a window from an earlier session dying late
/// cannot end the current one. Skipped while quitting: bringing the main
/// window back would only flash it.
pub fn on_session_window_destroyed<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if crate::shutdown::in_progress() {
        return;
    }
    let Some(state) = app.try_state::<PreviewSessionState>() else {
        return;
    };
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
        assert_eq!(state.twin_label().as_deref(), Some("led-twin-overlay-7"));
        state.feed.subscribe(
            "led-twin-overlay-7".into(),
            tauri::ipc::Channel::new(|_| Ok(())),
        );
        gate.store(true, Ordering::SeqCst);
        state.close_for_test();
        assert!(!gate.load(Ordering::Relaxed));
        assert_eq!(state.twin_label(), None);
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

    #[test]
    fn the_session_wire_shape_is_tagged_by_state() {
        assert_eq!(
            serde_json::to_value(PreviewSession::Closed).unwrap(),
            serde_json::json!({ "state": "closed" })
        );
        assert_eq!(
            serde_json::to_value(PreviewSession::Live {
                display_id: "a".into(),
                popup_hidden: true
            })
            .unwrap(),
            serde_json::json!({ "state": "live", "displayId": "a", "popupHidden": true })
        );
    }
}
