/**
 * LED Preview & Test Experience contracts (v1.6).
 *
 * Single source of truth for the whole preview/test surface:
 *
 * - **Synthetic-injection test patterns** — Rust generates procedural frames
 *   (solid / chase / rainbow / spiral / gamut) and pushes them through the
 *   *existing* ambilight worker, so a test pattern lights real LEDs + Hue
 *   channels exactly like live capture would.
 * - **Two preview webviews** — a click-through "digital twin" overlay
 *   (label prefix `led-twin-overlay-`) and an interactive control popup
 *   (label `led-control-popup`).
 * - **Per-LED color stream** — enriches `ambilight://edge-signal`
 *   (`EdgeSignalPayload` in `features/mode/model/contracts.ts`); owns the status surface.
 */

import type { LedCalibrationConfig } from "./calibration";
import type { DisplayId } from "./display";
import type { HueRuntimeTarget } from "./hue";

// ---------------------------------------------------------------------------
// Commands (Tauri invoke targets) — Rust #[tauri::command] names must match
// each value EXACTLY (snake_case). Phase 0 ships these strings; the Rust
// handlers + frontend *Api.ts invoke() bridges arrive in Phase 1.
// ---------------------------------------------------------------------------

export const PREVIEW_COMMANDS = {
  /** Start a synthetic test pattern; frames flow through the ambilight worker. */
  START_TEST_PATTERN: "start_led_test_pattern",
  /** Stop the active synthetic test pattern and return the worker to idle/live. */
  STOP_TEST_PATTERN: "stop_led_test_pattern",
  /** Read the current preview/test runtime snapshot (`LedPreviewStatus`). */
  GET_PREVIEW_STATUS: "get_led_preview_status",
  /** Open (or focus) the click-through digital-twin overlay window for a display. */
  OPEN_TWIN_OVERLAY: "open_led_twin_overlay",
  /** Close the digital-twin overlay window for a display (or all). */
  CLOSE_TWIN_OVERLAY: "close_led_twin_overlay",
  /** Create the interactive control popup window (hidden until shown). */
  OPEN_CONTROL_POPUP: "open_led_control_popup",
  /** Reveal the control popup near its persisted center. */
  SHOW_CONTROL_POPUP: "show_led_control_popup",
  /** Hide the control popup without destroying it (cheap re-show). */
  HIDE_CONTROL_POPUP: "hide_led_control_popup",
} as const;

export type PreviewCommandId = (typeof PREVIEW_COMMANDS)[keyof typeof PREVIEW_COMMANDS];

// ---------------------------------------------------------------------------
// Test pattern kinds
// ---------------------------------------------------------------------------

/**
 * Ordered list of synthetic test pattern kinds. `LedTestPattern` carries the
 * per-kind payload; this list + `LedTestPatternKind` are the discriminator
 * surface shared with the enriched `EdgeSignalPayload.pattern` field.
 */
export const LED_TEST_PATTERN_KIND = [
  "solid",
  "chase",
  "rainbow",
  "spiral",
  "gamut",
] as const;

export type LedTestPatternKind = (typeof LED_TEST_PATTERN_KIND)[number];

/**
 * Discriminated union of test patterns (discriminator `kind`).
 *
 * - `solid` / `chase` carry an explicit RGB triple (0..255 per channel).
 * - `rainbow` / `spiral` / `gamut` are fully procedural — the Rust generator
 *   owns their colour math, so no payload travels with them.
 */
export type LedTestPattern =
  | { kind: "solid"; r: number; g: number; b: number }
  | { kind: "chase"; r: number; g: number; b: number }
  | { kind: "rainbow" }
  | { kind: "spiral" }
  | { kind: "gamut" };

/** Animation cadence for time-varying patterns (chase / rainbow / spiral). */
export type TestPatternSpeed = "slow" | "med" | "fast";

// ---------------------------------------------------------------------------
// Command payloads + results
// ---------------------------------------------------------------------------

/** Payload for `start_led_test_pattern`. */
export interface StartLedTestPatternPayload {
  /** The pattern to inject (carries its own per-kind payload). */
  pattern: LedTestPattern;
  /** Master brightness scalar applied to the synthetic frame. Range 0..1. */
  brightness: number;
  /** Cadence for animated patterns. Ignored by static patterns (solid/gamut). */
  speed?: TestPatternSpeed;
  /**
   * Output targets the synthetic frame is streamed to. Absent ⇒ backend
   * default (USB-first, mirroring `resolveDefaultTargets`).
   */
  targets?: HueRuntimeTarget[];
  /** Strip layout to size the pattern with; absent ⇒ backend hydrates the
   * persisted one. LED Setup passes its *unsaved* editor layout so a test
   * verifies the counts being edited. */
  ledCalibration?: LedCalibrationConfig;
}

/**
 * Result of `start_led_test_pattern` / `stop_led_test_pattern`.
 *
 * `previewOnly` is `true` when the pattern is rendered into the twin overlay
 * (and the enriched edge-signal stream) but NOT pushed to a physical sink —
 * e.g. no calibration / no connected device — surfaced together with
 * `LED_TEST_PATTERN_PREVIEW_ONLY`.
 */
export interface LedTestPatternResult {
  active: boolean;
  previewOnly: boolean;
  status: {
    code: LedTestStatusCode;
    message: string;
    details?: string;
  };
}

// ---------------------------------------------------------------------------
// Twin overlay window
// ---------------------------------------------------------------------------

/**
 * Which signal the twin overlay mirrors.
 *
 * - `test` — synthetic test-pattern frames (always available, all platforms).
 * - `live` — live ambilight capture frames. Gated on Linux (see
 *   `TWIN_OVERLAY_UNSUPPORTED_PLATFORM_LIVE`) until the live-twin capture path
 *   is validated there.
 */
export type TwinScope = "test" | "live";

/** Payload for `open_led_twin_overlay`. */
export interface OpenLedTwinOverlayPayload {
  /** Display to overlay. Absent ⇒ backend falls back to the selected/primary display. */
  displayId?: DisplayId;
  /** Whether the overlay mirrors synthetic test frames or live capture. */
  scope: TwinScope;
}

/** Payload for `close_led_twin_overlay`. */
export interface CloseLedTwinOverlayPayload {
  /** Display whose overlay should close. Absent ⇒ close every open twin overlay. */
  displayId?: DisplayId;
}

/** Result of the twin overlay open/close commands. */
export interface TwinOverlayResult {
  ok: boolean;
  code: TwinOverlayStatusCode;
  message: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Control popup window
// ---------------------------------------------------------------------------

/** Result of the control popup open/show/hide commands. */
export interface ControlPopupResult {
  ok: boolean;
  code: ControlPopupStatusCode;
  message: string;
  /** Whether the popup window is currently visible after this call resolved. */
  visible: boolean;
}

// ---------------------------------------------------------------------------
// Preview runtime snapshot (`get_led_preview_status`)
// ---------------------------------------------------------------------------

/** Snapshot of the preview/test runtime, returned by `get_led_preview_status`. */
export interface LedPreviewStatus {
  /** Whether a synthetic test pattern is currently being injected. */
  testActive: boolean;
  /** What the enriched edge-signal stream currently carries. */
  source: "test" | "live" | "idle";
  /** Active synthetic pattern when `source === "test"`. */
  activePattern?: LedTestPattern;
  /** Displays that currently have a twin overlay window open. */
  twinDisplays: DisplayId[];
  /** Whether the interactive control popup is currently visible. */
  popupVisible: boolean;
  /**
   * Whether the live-scope twin overlay is supported on this platform.
   * `false` on Linux until the live-twin capture path is validated there;
   * the UI hides / disables the "live" toggle accordingly.
   */
  liveTwinSupported: boolean;
}

// ---------------------------------------------------------------------------
// Status codes — typed constants, never raw strings.
// ---------------------------------------------------------------------------

export const LED_TEST_STATUS = {
  /** Pattern accepted and now streaming to the configured sink(s). */
  PATTERN_STARTED: "LED_TEST_PATTERN_STARTED",
  /**
   * Pattern accepted but rendered to the twin overlay / edge-signal stream
   * only — no physical sink received frames (e.g. no device connected).
   * Pair with `LedTestPatternResult.previewOnly === true`.
   */
  PATTERN_PREVIEW_ONLY: "LED_TEST_PATTERN_PREVIEW_ONLY",
  /** Active pattern stopped; the worker returned to idle/live. */
  PATTERN_STOPPED: "LED_TEST_PATTERN_STOPPED",
  /** Payload failed validation (bad RGB range, brightness out of 0..1, unknown kind). */
  PATTERN_INVALID_PARAMS: "LED_TEST_PATTERN_INVALID_PARAMS",
  /**
   * No LED calibration exists, so the generator cannot size a frame for the
   * strip. The UI should route the user to the calibration flow.
   */
  PATTERN_NO_CALIBRATION: "LED_TEST_PATTERN_NO_CALIBRATION",
  /** The synthetic generator / worker hand-off failed at runtime. */
  PATTERN_RUNTIME_ERROR: "LED_TEST_PATTERN_RUNTIME_ERROR",
} as const;

export type LedTestStatusCode = (typeof LED_TEST_STATUS)[keyof typeof LED_TEST_STATUS];

export const TWIN_OVERLAY_STATUS = {
  /** Overlay window opened (or an already-open one was focused) for the display. */
  OPENED: "TWIN_OVERLAY_OPENED",
  /** Overlay window closed for the requested display (or all). */
  CLOSED: "TWIN_OVERLAY_CLOSED",
  /** Window creation / show failed at the webview layer. */
  OPEN_FAILED: "TWIN_OVERLAY_OPEN_FAILED",
  /** Destroy failed; `reason` lists the labels. A surviving twin is
   * click-through and undecorated, so the user cannot dismiss it. */
  CLOSE_FAILED: "TWIN_OVERLAY_CLOSE_FAILED",
  /** The requested `displayId` did not match any enumerated display. */
  DISPLAY_NOT_FOUND: "TWIN_OVERLAY_DISPLAY_NOT_FOUND",
  /**
   * A `live`-scope overlay was requested on a platform that does not yet
   * support live-twin capture (Linux). The UI should fall back to `test`
   * scope or hide the live toggle.
   */
  UNSUPPORTED_PLATFORM_LIVE: "TWIN_OVERLAY_UNSUPPORTED_PLATFORM_LIVE",
} as const;

export type TwinOverlayStatusCode =
  (typeof TWIN_OVERLAY_STATUS)[keyof typeof TWIN_OVERLAY_STATUS];

export const CONTROL_POPUP_STATUS = {
  /** Popup window created (hidden until a subsequent show call). */
  OPENED: "CONTROL_POPUP_OPENED",
  /** Popup revealed and focused. */
  SHOWN: "CONTROL_POPUP_SHOWN",
  /** Popup hidden without being destroyed (cheap re-show next time). */
  HIDDEN: "CONTROL_POPUP_HIDDEN",
  /** Window create / show / hide failed at the webview layer. */
  FAILED: "CONTROL_POPUP_FAILED",
} as const;

export type ControlPopupStatusCode =
  (typeof CONTROL_POPUP_STATUS)[keyof typeof CONTROL_POPUP_STATUS];

/** Thrown as `Err("CODE: detail")` before any status object is built, so a
 * `switch` on {@link TWIN_OVERLAY_STATUS} will never see them. */
export const PREVIEW_COMMAND_ERRORS = {
  TWIN_STATE_LOCK_FAILED: "LED_TWIN_STATE_LOCK_FAILED",
  TWIN_OVERLAY_SERIALIZE: "TWIN_OVERLAY_SERIALIZE",
} as const;

export type PreviewCommandErrorCode =
  (typeof PREVIEW_COMMAND_ERRORS)[keyof typeof PREVIEW_COMMAND_ERRORS];

// ---------------------------------------------------------------------------
// Window labels + event names
// ---------------------------------------------------------------------------

/**
 * Label prefix for twin overlay webview windows. One window per display;
 * the full label is `${LED_TWIN_OVERLAY_LABEL_PREFIX}${displayId}` so the
 * shell can address / close a single display's overlay without ambiguity.
 */
export const LED_TWIN_OVERLAY_LABEL_PREFIX = "led-twin-overlay-" as const;

/** Fixed label for the single interactive control popup webview window. */
export const LED_CONTROL_POPUP_LABEL = "led-control-popup" as const;

/**
 * Tauri event channel emitted whenever the preview runtime state changes
 * (test started/stopped, overlay opened/closed, popup shown/hidden). Carries
 * a `LedPreviewStatus` payload so every preview surface can reconcile without
 * polling `get_led_preview_status`.
 */
export const PREVIEW_STATE_CHANGED_EVENT = "preview://state-changed" as const;
