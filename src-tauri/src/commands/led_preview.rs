//! LED Preview surfaces (v1.6 — Phase 1).
//!
//! Two webviews mirror the live edge-signal stream:
//!
//! - **Digital-twin overlay** — a per-display, click-through, transparent,
//!   always-on-top window (label `led-twin-overlay-<counter>`) that renders the
//!   enriched `ambilight://edge-signal` per-LED buffer over the screen.
//! - **Control popup** — a single interactive, opaque amber-dark window (label
//!   `led-control-popup`) that drives the preview/test surface.
//!
//! Both windows load `index.html`; `src/main.tsx` routes by `getCurrentWindow()
//! .label`. The twin's display id is injected via an initialization script
//! (`window.__LUMASYNC_TWIN_DISPLAY_ID__`), mirroring the calibration overlay's
//! `__LUMASYNC_OVERLAY_PREVIEW__` pattern.
//!
//! Coded-status discipline: commands NEVER throw — they resolve with a coded
//! status on an ok-result. The `Result<_, String>` Err arm is reserved for
//! state-lock poison only.
//!
//! Phase 1 scope: the windows are created; capture-EXCLUSION (`SCContentFilter`
//! exclude / `SetWindowDisplayAffinity`) lands in Phase 2.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{
    window::Color, AppHandle, Emitter, LogicalPosition, Manager, Position, Runtime, State,
    WebviewUrl, WebviewWindowBuilder,
};

use super::calibration::{build_transparent_overlay, list_displays};
use super::lighting_mode::{LightingModeConfig, LightingRuntimeState};
use super::test_pattern::TestPatternKind;

// ---------------------------------------------------------------------------
// Window labels + event name — mirror `src/shared/contracts/preview.ts`
// ---------------------------------------------------------------------------

/// Label prefix for twin overlay windows. The full label is the prefix plus a
/// monotonic counter suffix (NOT the display id) so a frontend refresh while an
/// overlay is open cannot collide on Tauri's destroy-deferred label registry
/// (see calibration.rs `OVERLAY_LABEL_COUNTER`). The display id is injected via
/// `window.__LUMASYNC_TWIN_DISPLAY_ID__`; `main.tsx` matches `startsWith(prefix)`.
pub const LED_TWIN_OVERLAY_LABEL_PREFIX: &str = "led-twin-overlay-";

/// Fixed label for the single interactive control popup window.
pub const LED_CONTROL_POPUP_LABEL: &str = "led-control-popup";

/// Tauri event emitted whenever the preview runtime state changes.
pub const PREVIEW_STATE_CHANGED_EVENT: &str = "preview://state-changed";

// ---------------------------------------------------------------------------
// Status codes
// ---------------------------------------------------------------------------

const TWIN_OVERLAY_OPENED: &str = "TWIN_OVERLAY_OPENED";
const TWIN_OVERLAY_CLOSED: &str = "TWIN_OVERLAY_CLOSED";
const TWIN_OVERLAY_OPEN_FAILED: &str = "TWIN_OVERLAY_OPEN_FAILED";
const TWIN_OVERLAY_DISPLAY_NOT_FOUND: &str = "TWIN_OVERLAY_DISPLAY_NOT_FOUND";
const TWIN_OVERLAY_UNSUPPORTED_PLATFORM_LIVE: &str = "TWIN_OVERLAY_UNSUPPORTED_PLATFORM_LIVE";

const CONTROL_POPUP_OPENED: &str = "CONTROL_POPUP_OPENED";
const CONTROL_POPUP_SHOWN: &str = "CONTROL_POPUP_SHOWN";
const CONTROL_POPUP_HIDDEN: &str = "CONTROL_POPUP_HIDDEN";
const CONTROL_POPUP_FAILED: &str = "CONTROL_POPUP_FAILED";

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

/// Runtime book-keeping for the preview surfaces.
#[derive(Default)]
struct LedTwinRuntime {
    /// `displayId` → live twin-overlay window label.
    twin_labels: HashMap<String, String>,
    /// Whether the control popup is currently shown.
    control_visible: bool,
    /// Lighting mode captured when a test pattern preempted live output, so
    /// `stop_led_test_pattern` can restore it.
    prior_mode: Option<LightingModeConfig>,
}

/// Tauri-managed preview state. `preview_active` lives OUTSIDE the mutex as a
/// lock-free atomic so the ~10 Hz worker tick can read the enrichment gate
/// without contending on the (rarely-held) runtime lock.
pub struct LedTwinState {
    inner: Mutex<LedTwinRuntime>,
    preview_active: Arc<AtomicBool>,
}

impl Default for LedTwinState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(LedTwinRuntime::default()),
            preview_active: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl LedTwinState {
    fn runtime(&self) -> Result<MutexGuard<'_, LedTwinRuntime>, String> {
        self.inner
            .lock()
            .map_err(|error| format!("LED_TWIN_STATE_LOCK_FAILED: {error}"))
    }

    /// Clone of the shared enrichment gate, handed to each LIVE ambilight
    /// worker so a twin opened mid-run can flip enrichment on.
    pub fn preview_active(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.preview_active)
    }

    /// Snapshot the live twin-overlay window labels for fan-out (best-effort;
    /// a poisoned lock yields an empty list rather than wedging the hot path).
    pub fn twin_labels_snapshot(&self) -> Vec<String> {
        self.inner
            .lock()
            .map(|g| g.twin_labels.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Recompute the enrichment gate from the current surface set.
    fn recompute_preview_active(&self) {
        if let Ok(g) = self.inner.lock() {
            let active = g.control_visible || !g.twin_labels.is_empty();
            self.preview_active.store(active, Ordering::Relaxed);
        }
    }

    /// Set control-popup visibility and recompute the gate in one lock.
    fn set_control_visible(&self, visible: bool) {
        if let Ok(mut g) = self.inner.lock() {
            g.control_visible = visible;
            let active = g.control_visible || !g.twin_labels.is_empty();
            self.preview_active.store(active, Ordering::Relaxed);
        }
    }

    /// Capture the mode to restore when a test stops (best-effort).
    pub fn set_prior_mode(&self, mode: LightingModeConfig) {
        if let Ok(mut g) = self.inner.lock() {
            g.prior_mode = Some(mode);
        }
    }

    /// Take the captured prior mode, if any (best-effort).
    pub fn take_prior_mode(&self) -> Option<LightingModeConfig> {
        self.inner.lock().ok().and_then(|mut g| g.prior_mode.take())
    }

    /// Recompute the gate after a surface set change (test stop / external).
    pub fn recompute(&self) {
        self.recompute_preview_active();
    }

    /// Mark the control popup hidden (used by the lib.rs CloseRequested hook).
    pub fn mark_control_hidden(&self) {
        self.set_control_visible(false);
    }

    /// Drop a twin whose window died outside `close_led_twin_overlay`, so the
    /// enrichment gate stops counting a surface that no longer exists.
    pub fn forget_twin_label(&self, label: &str) {
        if let Ok(mut g) = self.inner.lock() {
            g.twin_labels.retain(|_, value| value != label);
        }
        self.recompute_preview_active();
    }
}

// Monotonic suffix counter — see `LED_TWIN_OVERLAY_LABEL_PREFIX`.
static TWIN_LABEL_COUNTER: AtomicU64 = AtomicU64::new(0);

fn build_twin_label() -> String {
    let seq = TWIN_LABEL_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{LED_TWIN_OVERLAY_LABEL_PREFIX}{seq}")
}

// ---------------------------------------------------------------------------
// Command payloads + results
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenLedTwinOverlayPayload {
    #[serde(default)]
    pub display_id: Option<String>,
    /// `"test"` | `"live"`.
    pub scope: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseLedTwinOverlayPayload {
    #[serde(default)]
    pub display_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwinOverlayResult {
    pub ok: bool,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPopupResult {
    pub ok: bool,
    pub code: String,
    pub message: String,
    pub visible: bool,
}

// ---------------------------------------------------------------------------
// Preview runtime snapshot (`get_led_preview_status` + `preview://state-changed`)
// ---------------------------------------------------------------------------

/// Lighting-side slice of the preview status, produced by
/// `LightingRuntimeState::preview_snapshot`.
pub struct PreviewModeSnapshot {
    pub test_active: bool,
    pub source: &'static str,
    pub active_pattern: Option<TestPatternKind>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedPreviewStatus {
    pub test_active: bool,
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_pattern: Option<TestPatternKind>,
    pub twin_displays: Vec<String>,
    pub popup_visible: bool,
    pub live_twin_supported: bool,
}

/// Merge the lighting-side snapshot with the twin/popup state into the full
/// `LedPreviewStatus`. Lock acquisition order is lighting → twin everywhere to
/// avoid cross-lock deadlock.
pub fn build_preview_status(
    snapshot: PreviewModeSnapshot,
    twin: &LedTwinState,
) -> LedPreviewStatus {
    let (twin_displays, popup_visible) = match twin.inner.lock() {
        Ok(g) => (g.twin_labels.keys().cloned().collect(), g.control_visible),
        Err(_) => (Vec::new(), false),
    };
    LedPreviewStatus {
        test_active: snapshot.test_active,
        source: snapshot.source,
        active_pattern: snapshot.active_pattern,
        twin_displays,
        popup_visible,
        // Live-scope twin capture is gated off on Linux until validated there.
        live_twin_supported: !cfg!(target_os = "linux"),
    }
}

/// Build + broadcast the current `LedPreviewStatus` on `preview://state-changed`.
///
/// MUST be called with neither the lighting owner nor the twin runtime lock
/// held by the caller (it re-acquires both, lighting → twin).
pub fn emit_preview_state_changed<R: Runtime>(app: &AppHandle<R>) {
    let Some(runtime_state) = app.try_state::<LightingRuntimeState>() else {
        return;
    };
    let Some(twin_state) = app.try_state::<LedTwinState>() else {
        return;
    };
    let snapshot = runtime_state.preview_snapshot();
    let status = build_preview_status(snapshot, &twin_state);
    let _ = app.emit(PREVIEW_STATE_CHANGED_EVENT, status);
}

// ---------------------------------------------------------------------------
// Twin overlay commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn open_led_twin_overlay<R: Runtime>(
    app: AppHandle<R>,
    twin_state: State<'_, LedTwinState>,
    payload: OpenLedTwinOverlayPayload,
) -> Result<TwinOverlayResult, String> {
    // Live-scope twin capture is not yet validated on Linux (Phase 2).
    if payload.scope == "live" && cfg!(target_os = "linux") {
        return Ok(TwinOverlayResult {
            ok: false,
            code: TWIN_OVERLAY_UNSUPPORTED_PLATFORM_LIVE.to_string(),
            message: "Live-scope twin overlay is not supported on this platform yet.".to_string(),
            reason: None,
        });
    }

    let displays = list_displays(app.clone())?;
    let target = match payload.display_id.as_ref() {
        Some(id) => match displays.iter().find(|d| &d.id == id) {
            Some(display) => display.clone(),
            None => {
                return Ok(TwinOverlayResult {
                    ok: false,
                    code: TWIN_OVERLAY_DISPLAY_NOT_FOUND.to_string(),
                    message: "Requested display was not found.".to_string(),
                    reason: Some(format!(
                        "display id='{id}' did not match any enumerated display"
                    )),
                });
            }
        },
        None => match displays
            .iter()
            .find(|d| d.is_primary)
            .or_else(|| displays.first())
            .cloned()
        {
            Some(display) => display,
            None => {
                return Ok(TwinOverlayResult {
                    ok: false,
                    code: TWIN_OVERLAY_OPEN_FAILED.to_string(),
                    message: "No displays available for the twin overlay.".to_string(),
                    reason: None,
                });
            }
        },
    };

    let resolved_id = target.id.clone();

    // Single overlay per display — tear down any existing one first.
    {
        let mut rt = twin_state.runtime()?;
        if let Some(old_label) = rt.twin_labels.remove(&resolved_id) {
            if let Some(window) = app.get_webview_window(&old_label) {
                let _ = window.destroy();
            }
        }
    }

    let label = build_twin_label();
    let display_id_json =
        serde_json::to_string(&resolved_id).map_err(|e| format!("TWIN_OVERLAY_SERIALIZE: {e}"))?;
    let scope_json = serde_json::to_string(&payload.scope)
        .map_err(|e| format!("TWIN_OVERLAY_SERIALIZE: {e}"))?;
    let init_script = format!(
        "window.__LUMASYNC_TWIN_DISPLAY_ID__ = {display_id_json}; window.__LUMASYNC_TWIN_SCOPE__ = {scope_json};"
    );

    let url = WebviewUrl::App(PathBuf::from("index.html"));
    match build_transparent_overlay(
        &app,
        &label,
        url,
        "LumaSync LED Twin",
        &target,
        Some(init_script.as_str()),
    ) {
        Ok(window) => {
            #[cfg(target_os = "macos")]
            crate::macos_window::elevate_overlay_window(&window);
            let _ = &window;

            {
                let mut rt = twin_state.runtime()?;
                rt.twin_labels.insert(resolved_id.clone(), label);
            }
            twin_state.recompute_preview_active();
            emit_preview_state_changed(&app);

            Ok(TwinOverlayResult {
                ok: true,
                code: TWIN_OVERLAY_OPENED.to_string(),
                message: "Twin overlay opened.".to_string(),
                reason: None,
            })
        }
        Err(reason) => Ok(TwinOverlayResult {
            ok: false,
            code: TWIN_OVERLAY_OPEN_FAILED.to_string(),
            message: "Could not open the twin overlay.".to_string(),
            reason: Some(reason),
        }),
    }
}

#[tauri::command]
pub fn close_led_twin_overlay<R: Runtime>(
    app: AppHandle<R>,
    twin_state: State<'_, LedTwinState>,
    payload: CloseLedTwinOverlayPayload,
) -> Result<TwinOverlayResult, String> {
    {
        let mut rt = twin_state.runtime()?;
        match payload.display_id.as_ref() {
            Some(id) => {
                if let Some(label) = rt.twin_labels.remove(id) {
                    if let Some(window) = app.get_webview_window(&label) {
                        let _ = window.destroy();
                    }
                }
            }
            None => {
                for (_, label) in rt.twin_labels.drain() {
                    if let Some(window) = app.get_webview_window(&label) {
                        let _ = window.destroy();
                    }
                }
            }
        }
    }

    twin_state.recompute_preview_active();
    emit_preview_state_changed(&app);

    Ok(TwinOverlayResult {
        ok: true,
        code: TWIN_OVERLAY_CLOSED.to_string(),
        message: "Twin overlay closed.".to_string(),
        reason: None,
    })
}

// ---------------------------------------------------------------------------
// Control popup commands
// ---------------------------------------------------------------------------

/// Read the persisted control-popup center (logical px) from the shell store on
/// disk, mirroring `lighting_mode::hydrate_*`. Absent ⇒ `None` (OS placement).
fn read_persisted_popup_center<R: Runtime>(app: &AppHandle<R>) -> Option<(f64, f64)> {
    let dir = app.path().app_data_dir().ok()?;
    let raw = std::fs::read_to_string(dir.join("shell-state.json")).ok()?;
    let root: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let state = root.get("shell-state")?;
    let x = state.get("ledPreviewPopupCenterX")?.as_f64()?;
    let y = state.get("ledPreviewPopupCenterY")?.as_f64()?;
    Some((x, y))
}

const POPUP_WIDTH: f64 = 320.0;
const POPUP_HEIGHT: f64 = 460.0;

#[tauri::command]
pub fn open_led_control_popup<R: Runtime>(
    app: AppHandle<R>,
    twin_state: State<'_, LedTwinState>,
) -> Result<ControlPopupResult, String> {
    if app.get_webview_window(LED_CONTROL_POPUP_LABEL).is_none() {
        let url = WebviewUrl::App(PathBuf::from("index.html"));
        let builder = WebviewWindowBuilder::new(&app, LED_CONTROL_POPUP_LABEL, url)
            .title("LumaSync LED Controls")
            .inner_size(POPUP_WIDTH, POPUP_HEIGHT)
            .min_inner_size(300.0, 420.0)
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .focused(true)
            .visible(true)
            // OPAQUE amber-dark — NOT transparent, NOT click-through.
            .background_color(Color(18, 16, 14, 255));

        let window = match builder.build() {
            Ok(window) => window,
            Err(error) => {
                return Ok(ControlPopupResult {
                    ok: false,
                    code: CONTROL_POPUP_FAILED.to_string(),
                    message: format!("Could not create the control popup: {error}"),
                    visible: false,
                });
            }
        };

        // Restore to the persisted center, else let the OS place it.
        if let Some((cx, cy)) = read_persisted_popup_center(&app) {
            let _ = window.set_position(Position::Logical(LogicalPosition::new(
                cx - POPUP_WIDTH / 2.0,
                cy - POPUP_HEIGHT / 2.0,
            )));
        } else {
            let _ = window.center();
        }

        #[cfg(target_os = "macos")]
        crate::macos_window::elevate_overlay_window(&window);
    } else if let Some(window) = app.get_webview_window(LED_CONTROL_POPUP_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }

    twin_state.set_control_visible(true);
    emit_preview_state_changed(&app);

    Ok(ControlPopupResult {
        ok: true,
        code: CONTROL_POPUP_OPENED.to_string(),
        message: "Control popup ready.".to_string(),
        visible: true,
    })
}

#[tauri::command]
pub fn show_led_control_popup<R: Runtime>(
    app: AppHandle<R>,
    twin_state: State<'_, LedTwinState>,
) -> Result<ControlPopupResult, String> {
    match app.get_webview_window(LED_CONTROL_POPUP_LABEL) {
        Some(window) => {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            twin_state.set_control_visible(true);
            emit_preview_state_changed(&app);
            Ok(ControlPopupResult {
                ok: true,
                code: CONTROL_POPUP_SHOWN.to_string(),
                message: "Control popup shown.".to_string(),
                visible: true,
            })
        }
        None => Ok(ControlPopupResult {
            ok: false,
            code: CONTROL_POPUP_FAILED.to_string(),
            message: "Control popup does not exist; call open_led_control_popup first.".to_string(),
            visible: false,
        }),
    }
}

#[tauri::command]
pub fn hide_led_control_popup<R: Runtime>(
    app: AppHandle<R>,
    twin_state: State<'_, LedTwinState>,
) -> Result<ControlPopupResult, String> {
    if let Some(window) = app.get_webview_window(LED_CONTROL_POPUP_LABEL) {
        let _ = window.hide();
    }
    twin_state.set_control_visible(false);
    emit_preview_state_changed(&app);
    Ok(ControlPopupResult {
        ok: true,
        code: CONTROL_POPUP_HIDDEN.to_string(),
        message: "Control popup hidden.".to_string(),
        visible: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn twin_label_uses_prefix_and_is_unique() {
        let a = build_twin_label();
        let b = build_twin_label();
        assert!(a.starts_with(LED_TWIN_OVERLAY_LABEL_PREFIX));
        assert!(b.starts_with(LED_TWIN_OVERLAY_LABEL_PREFIX));
        assert_ne!(a, b, "monotonic counter must yield unique labels");
    }

    #[test]
    fn preview_active_gate_tracks_surfaces() {
        let state = LedTwinState::default();
        assert!(!state.preview_active().load(Ordering::Relaxed));

        state.set_control_visible(true);
        assert!(state.preview_active().load(Ordering::Relaxed));

        state.set_control_visible(false);
        assert!(!state.preview_active().load(Ordering::Relaxed));

        {
            let mut rt = state.runtime().expect("lock");
            rt.twin_labels
                .insert("d1".into(), "led-twin-overlay-0".into());
        }
        state.recompute();
        assert!(state.preview_active().load(Ordering::Relaxed));
    }

    #[test]
    fn prior_mode_round_trips() {
        let state = LedTwinState::default();
        assert!(state.take_prior_mode().is_none());
        state.set_prior_mode(LightingModeConfig::default());
        assert!(state.take_prior_mode().is_some());
        assert!(state.take_prior_mode().is_none());
    }
}
