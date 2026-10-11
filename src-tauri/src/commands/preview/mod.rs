//! The LED preview: one session that owns the control popup, the twin over the
//! captured display, and the main window's absence while they are up.
//!
//! - `session` — the state and its commands; every way out goes through
//!   `end_session`.
//! - `windows` — how the popup and the twin are built.
//! - `exclusion` — keeping them out of the live capture.
//! - `feed` — the twin's layout and frames.

pub mod exclusion;
pub mod feed;
pub mod session;
pub mod windows;

pub use session::{end_session, on_session_window_destroyed, PreviewSessionState};
#[cfg(test)]
pub use windows::LED_CONTROL_POPUP_LABEL_PREFIX;
pub use windows::{apply_ui_zoom_later, is_preview_window, watch_front_app};
