/**
 * Platform surface contracts (v1.4 — Tauri notification plugin).
 *
 * Wraps OS-level capabilities that are not device-specific: toast
 * notifications today, with room for global shortcuts / clipboard in
 * later milestones.
 *
 * Every command returns a coded status object (never throws on the
 * Rust side) so the frontend can discriminate on `result.status`
 * without parsing human strings. Mirrors the Hue-never-throws
 * discipline.
 */

// ---------------------------------------------------------------------------
// Platform commands
// ---------------------------------------------------------------------------

export const PLATFORM_COMMANDS = {
  /**
   * Request permission to show OS notifications. On macOS this triggers
   * the system prompt on first call and resolves silently on subsequent
   * calls. On Linux / Windows the plugin typically resolves immediately
   * with `NOTIF_PERMISSION_GRANTED`.
   */
  REQUEST_NOTIFICATION_PERMISSION: "request_notification_permission",
  /**
   * Show a single notification toast. Fails with `NOTIF_PERMISSION_DENIED`
   * if the user previously rejected the permission prompt; the frontend
   * should then fall back to an in-app status banner.
   */
  SHOW_NOTIFICATION: "show_notification",
  /**
   * Reveal the LumaSync app log directory in the host file browser.
   * Returns a plain `Result<void, string>` (no discriminated status)
   * because there is no actionable branching — either it succeeded
   * or the user sees the message in a toast / boundary action row.
   */
  OPEN_LOG_DIR: "open_log_dir",
} as const;

export type PlatformCommandId =
  (typeof PLATFORM_COMMANDS)[keyof typeof PLATFORM_COMMANDS];

// ---------------------------------------------------------------------------
// Notification shape
// ---------------------------------------------------------------------------

/**
 * Notification severity. Used to pick the toast icon and i18n copy
 * bucket; the OS may or may not render a distinct icon per kind
 * depending on platform capabilities.
 */
export type NotificationKind = "info" | "warn" | "error";

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  "info",
  "warn",
  "error",
] as const;

export interface NotificationPayload {
  title: string;
  body: string;
  kind: NotificationKind;
}

// ---------------------------------------------------------------------------
// Notification result discriminated union
// ---------------------------------------------------------------------------

/**
 * Status codes for `SHOW_NOTIFICATION` and
 * `REQUEST_NOTIFICATION_PERMISSION`. Additive string union so the Rust
 * handler can grow new codes without breaking existing discriminators.
 */
export const NOTIFICATION_RESULT_CODES = {
  /** User granted the permission (or OS never requires one). */
  PERMISSION_GRANTED: "NOTIF_PERMISSION_GRANTED",
  /** User (or OS policy) explicitly denied the permission. */
  PERMISSION_DENIED: "NOTIF_PERMISSION_DENIED",
  /** OS does not expose a notification surface we can use. */
  UNSUPPORTED_OS: "NOTIF_UNSUPPORTED_OS",
} as const;

export type NotificationResultCode =
  (typeof NOTIFICATION_RESULT_CODES)[keyof typeof NOTIFICATION_RESULT_CODES];

/**
 * Discriminated union returned by the platform notification commands.
 * Frontend callers must branch on `result.status` — never inspect
 * `result.code` in isolation.
 */
export type NotificationResult =
  | { status: "shown" }
  | {
      status: "denied" | "unsupported";
      code: NotificationResultCode;
      message?: string;
    };
