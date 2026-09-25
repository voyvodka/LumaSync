//! Single source for every Tauri event name emitted or listened to across the
//! IPC boundary. Each constant has an exact-string counterpart in a grouped
//! `*_EVENTS` object under `src/shared/contracts/` — `verify:event-names`
//! (`scripts/verify/event-names.mjs`) fails the build if the two drift, or if
//! an `.emit*(` / `listen(` call site uses a raw string instead of one of
//! these.
//!
//! Most of these constants used to be defined next to their emit site and are
//! re-exported from there (`pub use crate::events::X;`) so existing import
//! paths (`commands::shell_state::SHELL_STATE_CHANGED_EVENT`, etc.) keep
//! working — read the constant's doc comment for where it is actually used.

/// `LIGHTING_EVENTS.RUNTIME_CHANGED` in `src/shared/contracts/lightingRuntime.ts`.
/// Re-exported from `commands::lighting_mode::snapshot`.
pub const LIGHTING_RUNTIME_CHANGED_EVENT: &str = "lighting://runtime-changed";

/// `SHELL_EVENTS.STATE_CHANGED` in `src/shared/contracts/shell.ts`.
/// Re-exported from `commands::shell_state`.
pub const SHELL_STATE_CHANGED_EVENT: &str = "shell://state-changed";

/// `SHELL_EVENTS.CLOSE_TO_TRAY` in `src/shared/contracts/shell.ts`. Emitted
/// from `lib.rs` when the main window is hidden to the tray instead of closed.
pub const SHELL_CLOSE_TO_TRAY_EVENT: &str = "shell:close-to-tray";

/// `TRAY_EVENTS.SHOW_LED_PREVIEW` in `src/shared/contracts/shell.ts`. Emitted
/// from the tray menu handler in `lib.rs`.
pub const TRAY_SHOW_LED_PREVIEW_EVENT: &str = "tray:show-led-preview";

/// `HUE_EVENTS.HEALTH_CHANGED` in `src/shared/contracts/hueHealth.ts`.
/// Re-exported from `commands::hue::health`.
pub const HUE_HEALTH_CHANGED_EVENT: &str = "hue://health";

/// `PREVIEW_EVENTS.STATE_CHANGED` in `src/shared/contracts/preview.ts`.
/// Re-exported from `commands::led_preview`.
pub const PREVIEW_STATE_CHANGED_EVENT: &str = "preview://state-changed";

/// `PREVIEW_EVENTS.EDGE_SIGNAL` in `src/shared/contracts/preview.ts`.
/// Re-exported from `commands::lighting_mode::preview`.
pub const EDGE_SIGNAL_EVENT: &str = "ambilight://edge-signal";

/// `TELEMETRY_EVENTS.HEALTH_CHANGED` in `src/shared/contracts/telemetry.ts`.
/// Re-exported from `commands::runtime_telemetry`.
pub const RUNTIME_HEALTH_CHANGED_EVENT: &str = "telemetry://health-changed";

/// `UPDATER_EVENTS.DOWNLOAD_PROGRESS` in `src/shared/contracts/updater.ts`.
/// Used directly from `commands::updater`.
pub const UPDATER_PROGRESS_EVENT: &str = "updater://download-progress";

/// `SHELL_EVENTS.MAIN_WINDOW_VISIBILITY` in `src/shared/contracts/shell.ts`.
/// Re-exported from `commands::window_visibility`.
pub const MAIN_WINDOW_VISIBILITY_EVENT: &str = "shell://main-window-visibility";
