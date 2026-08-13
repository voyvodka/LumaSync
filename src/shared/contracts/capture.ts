/** Reasons riding `status.details` on `AMBILIGHT_MODE_START_FAILED` and
 *  `SOLID_MODE_APPLY_FAILED`, never codes of their own. The `LED_OUTPUT_*` family
 *  shares the field without being capture reasons — see `LedOutputError::as_reason`. */
export const AMBILIGHT_CAPTURE_REASON = {
  /** Only ever produced after a real `CGPreflightScreenCaptureAccess` probe. */
  PERMISSION_DENIED: "AMBILIGHT_CAPTURE_PERMISSION_DENIED",
  /** ScreenCaptureKit failed *with* permission granted — not a consent problem. */
  SHAREABLE_CONTENT_FAILED: "AMBILIGHT_CAPTURE_SHAREABLE_CONTENT_FAILED",
  MONITOR_NOT_FOUND: "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
  UNSUPPORTED_PLATFORM: "AMBILIGHT_CAPTURE_UNSUPPORTED_PLATFORM",
  FRAME_UNAVAILABLE: "AMBILIGHT_CAPTURE_FRAME_UNAVAILABLE",
  SESSION_START_FAILED: "AMBILIGHT_CAPTURE_SESSION_START_FAILED",
  FRAME_LOCK_FAILED: "AMBILIGHT_CAPTURE_FRAME_LOCK_FAILED",
  FRAME_BUFFER_FAILED: "AMBILIGHT_CAPTURE_FRAME_BUFFER_FAILED",
  PIXEL_BUFFER_INVALID: "AMBILIGHT_CAPTURE_PIXEL_BUFFER_INVALID",
  THREAD_JOIN_FAILED: "AMBILIGHT_CAPTURE_THREAD_JOIN_FAILED",
  WINRT_INIT_FAILED: "AMBILIGHT_CAPTURE_WINRT_INIT_FAILED",
  DISPATCHER_INIT_FAILED: "AMBILIGHT_CAPTURE_DISPATCHER_INIT_FAILED",
  DISPATCHER_SHUTDOWN_FAILED: "AMBILIGHT_CAPTURE_DISPATCHER_SHUTDOWN_FAILED",
  DISPATCHER_CALLBACK_FAILED: "AMBILIGHT_CAPTURE_DISPATCHER_CALLBACK_FAILED",
  ITEM_CONVERSION_FAILED: "AMBILIGHT_CAPTURE_ITEM_CONVERSION_FAILED",
  D3D_INIT_FAILED: "AMBILIGHT_CAPTURE_D3D_INIT_FAILED",
  MESSAGE_LOOP_FAILED: "AMBILIGHT_CAPTURE_MESSAGE_LOOP_FAILED",
  THREAD_START_FAILED: "AMBILIGHT_CAPTURE_THREAD_START_FAILED",
  LED_OUTPUT_PORT_UNAVAILABLE: "LED_OUTPUT_PORT_UNAVAILABLE",
  LED_OUTPUT_PORT_OPEN_FAILED: "LED_OUTPUT_PORT_OPEN_FAILED",
  LED_OUTPUT_DEVICE_NOT_CONNECTED: "LED_OUTPUT_DEVICE_NOT_CONNECTED",
  LED_OUTPUT_WRITE_FAILED: "LED_OUTPUT_WRITE_FAILED",
  LED_OUTPUT_FLUSH_FAILED: "LED_OUTPUT_FLUSH_FAILED",
  LED_OUTPUT_SESSION_LOCK_FAILED: "LED_OUTPUT_SESSION_LOCK_FAILED",
  LED_OUTPUT_CONNECTION_STATE_LOCK_FAILED: "LED_OUTPUT_CONNECTION_STATE_LOCK_FAILED",
} as const;

export type AmbilightCaptureReason =
  (typeof AMBILIGHT_CAPTURE_REASON)[keyof typeof AMBILIGHT_CAPTURE_REASON];

/** What the user can do about it — 25 reasons, 6 buckets, because most are log-only. */
export const CAPTURE_FAILURE_BUCKET = {
  /** macOS screen recording. The preflight cannot separate "denied" from "never
   *  asked", so copy must read "check this permission", never "you denied it". */
  PERMISSION: "permission",
  /** The chosen display is gone; pick another. */
  DISPLAY: "display",
  /** Retry by toggling the mode. */
  TRANSIENT: "transient",
  /** No capture backend on this platform. */
  UNSUPPORTED: "unsupported",
  /** Not a capture problem — the LED output port went away. */
  OUTPUT: "output",
  /** Everything else, including reasons this build does not know about. */
  INTERNAL: "internal",
} as const;

export type CaptureFailureBucket =
  (typeof CAPTURE_FAILURE_BUCKET)[keyof typeof CAPTURE_FAILURE_BUCKET];

const BUCKET_BY_REASON: Readonly<Record<AmbilightCaptureReason, CaptureFailureBucket>> = {
  [AMBILIGHT_CAPTURE_REASON.PERMISSION_DENIED]: CAPTURE_FAILURE_BUCKET.PERMISSION,
  [AMBILIGHT_CAPTURE_REASON.MONITOR_NOT_FOUND]: CAPTURE_FAILURE_BUCKET.DISPLAY,
  [AMBILIGHT_CAPTURE_REASON.UNSUPPORTED_PLATFORM]: CAPTURE_FAILURE_BUCKET.UNSUPPORTED,
  [AMBILIGHT_CAPTURE_REASON.FRAME_UNAVAILABLE]: CAPTURE_FAILURE_BUCKET.TRANSIENT,
  // Two different underlying causes on two platforms, neither nameable from
  // here; "toggle it off and on" is the only honest advice either way.
  [AMBILIGHT_CAPTURE_REASON.SESSION_START_FAILED]: CAPTURE_FAILURE_BUCKET.TRANSIENT,
  // Usually a wedged `replayd`, which a restart of the stream does clear.
  [AMBILIGHT_CAPTURE_REASON.SHAREABLE_CONTENT_FAILED]: CAPTURE_FAILURE_BUCKET.TRANSIENT,
  [AMBILIGHT_CAPTURE_REASON.FRAME_LOCK_FAILED]: CAPTURE_FAILURE_BUCKET.INTERNAL,
  [AMBILIGHT_CAPTURE_REASON.FRAME_BUFFER_FAILED]: CAPTURE_FAILURE_BUCKET.INTERNAL,
  [AMBILIGHT_CAPTURE_REASON.PIXEL_BUFFER_INVALID]: CAPTURE_FAILURE_BUCKET.INTERNAL,
  [AMBILIGHT_CAPTURE_REASON.THREAD_JOIN_FAILED]: CAPTURE_FAILURE_BUCKET.INTERNAL,
  [AMBILIGHT_CAPTURE_REASON.WINRT_INIT_FAILED]: CAPTURE_FAILURE_BUCKET.INTERNAL,
  [AMBILIGHT_CAPTURE_REASON.DISPATCHER_INIT_FAILED]: CAPTURE_FAILURE_BUCKET.INTERNAL,
  [AMBILIGHT_CAPTURE_REASON.DISPATCHER_SHUTDOWN_FAILED]: CAPTURE_FAILURE_BUCKET.INTERNAL,
  [AMBILIGHT_CAPTURE_REASON.DISPATCHER_CALLBACK_FAILED]: CAPTURE_FAILURE_BUCKET.INTERNAL,
  [AMBILIGHT_CAPTURE_REASON.ITEM_CONVERSION_FAILED]: CAPTURE_FAILURE_BUCKET.INTERNAL,
  [AMBILIGHT_CAPTURE_REASON.D3D_INIT_FAILED]: CAPTURE_FAILURE_BUCKET.INTERNAL,
  [AMBILIGHT_CAPTURE_REASON.MESSAGE_LOOP_FAILED]: CAPTURE_FAILURE_BUCKET.INTERNAL,
  [AMBILIGHT_CAPTURE_REASON.THREAD_START_FAILED]: CAPTURE_FAILURE_BUCKET.INTERNAL,
  [AMBILIGHT_CAPTURE_REASON.LED_OUTPUT_PORT_UNAVAILABLE]: CAPTURE_FAILURE_BUCKET.OUTPUT,
  [AMBILIGHT_CAPTURE_REASON.LED_OUTPUT_PORT_OPEN_FAILED]: CAPTURE_FAILURE_BUCKET.OUTPUT,
  [AMBILIGHT_CAPTURE_REASON.LED_OUTPUT_DEVICE_NOT_CONNECTED]: CAPTURE_FAILURE_BUCKET.OUTPUT,
  [AMBILIGHT_CAPTURE_REASON.LED_OUTPUT_WRITE_FAILED]: CAPTURE_FAILURE_BUCKET.OUTPUT,
  [AMBILIGHT_CAPTURE_REASON.LED_OUTPUT_FLUSH_FAILED]: CAPTURE_FAILURE_BUCKET.OUTPUT,
  // Poisoned mutexes, not a device problem — the user can only restart.
  [AMBILIGHT_CAPTURE_REASON.LED_OUTPUT_SESSION_LOCK_FAILED]: CAPTURE_FAILURE_BUCKET.INTERNAL,
  [AMBILIGHT_CAPTURE_REASON.LED_OUTPUT_CONNECTION_STATE_LOCK_FAILED]: CAPTURE_FAILURE_BUCKET.INTERNAL,
};

/** A classified `status.details`, carrying the raw reason for the log-facing copy. */
export interface CaptureFailureNotice {
  bucket: CaptureFailureBucket;
  /** Verbatim `status.details`; empty when the backend sent none. */
  reason: string;
}

export function isAmbilightCaptureReason(value: string): value is AmbilightCaptureReason {
  // Not `Object.hasOwn`: tsconfig targets ES2020.
  return Object.prototype.hasOwnProperty.call(BUCKET_BY_REASON, value);
}

/** Unknown reasons bucket as `internal`, never throw: a newer backend must not
 *  break an older frontend, and `internal` shows the raw reason regardless. */
export function classifyCaptureFailure(details: string | null | undefined): CaptureFailureBucket {
  if (!details) return CAPTURE_FAILURE_BUCKET.INTERNAL;
  // Some Err arms carry the code as a `"CODE: context"` prefix rather than bare.
  const code = details.trim().split(":", 1)[0]?.trim() ?? "";
  if (!isAmbilightCaptureReason(code)) return CAPTURE_FAILURE_BUCKET.INTERNAL;
  return BUCKET_BY_REASON[code];
}

/** `classifyCaptureFailure` plus the raw reason, ready to hand to a notice. */
export function describeCaptureFailure(details: string | null | undefined): CaptureFailureNotice {
  return {
    bucket: classifyCaptureFailure(details),
    reason: details?.trim() ?? "",
  };
}

// ---------------------------------------------------------------------------
// Screen-recording permission (macOS TCC)
// ---------------------------------------------------------------------------

export const CAPTURE_COMMANDS = {
  /** Non-prompting probe. Never throws; safe to call before every start. */
  GET_SCREEN_CAPTURE_PERMISSION: "get_screen_capture_permission",
  /** Deep-links the Screen Recording pane. No-op code off macOS. */
  OPEN_SCREEN_CAPTURE_SETTINGS: "open_screen_capture_settings",
} as const;

export type CaptureCommandId = (typeof CAPTURE_COMMANDS)[keyof typeof CAPTURE_COMMANDS];

export const SCREEN_CAPTURE_PERMISSION_STATUS = {
  GRANTED: "SCREEN_CAPTURE_PERMISSION_GRANTED",
  /** Denied **or** never asked — `CGPreflightScreenCaptureAccess` cannot tell
   *  the two apart, so copy must stay "check this", never "you denied it". */
  DENIED: "SCREEN_CAPTURE_PERMISSION_DENIED",
  /** Windows / X11: no consent gate exists, so there is nothing to offer. */
  NOT_REQUIRED: "SCREEN_CAPTURE_PERMISSION_NOT_REQUIRED",
} as const;

export type ScreenCapturePermissionCode =
  (typeof SCREEN_CAPTURE_PERMISSION_STATUS)[keyof typeof SCREEN_CAPTURE_PERMISSION_STATUS];

export interface ScreenCapturePermissionResult {
  code: ScreenCapturePermissionCode;
}

export const SCREEN_CAPTURE_SETTINGS_STATUS = {
  OPENED: "SCREEN_CAPTURE_SETTINGS_OPENED",
  UNSUPPORTED: "SCREEN_CAPTURE_SETTINGS_UNSUPPORTED",
  OPEN_FAILED: "SCREEN_CAPTURE_SETTINGS_OPEN_FAILED",
} as const;

export type ScreenCaptureSettingsCode =
  (typeof SCREEN_CAPTURE_SETTINGS_STATUS)[keyof typeof SCREEN_CAPTURE_SETTINGS_STATUS];

export interface ScreenCaptureSettingsResult {
  code: ScreenCaptureSettingsCode;
  message: string | null;
}

/** Only `DENIED` means the user has something to fix — `NOT_REQUIRED` must
 *  never raise a permission notice on a platform that has no such permission. */
export function isScreenCaptureBlocked(code: string): boolean {
  return code === SCREEN_CAPTURE_PERMISSION_STATUS.DENIED;
}
