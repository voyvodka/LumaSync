/**
 * LED preview contracts.
 *
 * - **Preview session** — one Rust-owned session opens the control popup and
 *   the click-through twin over the captured display, hides the main window,
 *   and puts everything back on any way out (`close_preview`, the popup's
 *   close, the tray). Opening it changes no light.
 * - **Synthetic-injection test patterns** — Rust generates procedural frames
 *   and pushes them through the ambilight worker. LED Setup and Devices use
 *   them; the preview does not.
 * - **Twin feed** — the twin subscribes with a `Channel` and receives raw
 *   frames (`TWIN_FRAME`), each cut for one `TwinLayout` revision; the layout
 *   follows on `preview://twin-layout` when the running mode's changes.
 * - **Scenes** — a full-screen window under the twin and the popup plays a
 *   test scene that Ambilight captures. The scene owns the lights while it
 *   plays; stopping it brings back the mode it interrupted, and a mode change
 *   from anywhere ends it.
 */

import type { LedCalibrationConfig } from "./calibration";
import type { DisplayId } from "./display";
import type { HueRuntimeTarget } from "./hue";
import type { CommandStatusOf } from "./status";

// ---------------------------------------------------------------------------
// Commands (Tauri invoke targets) — Rust #[tauri::command] names must match
// each value EXACTLY (snake_case).
// ---------------------------------------------------------------------------

export const PREVIEW_COMMANDS = {
  /** Start a synthetic test pattern; frames flow through the ambilight worker. */
  START_TEST_PATTERN: "start_led_test_pattern",
  /** Stop the active synthetic test pattern and return the worker to idle/live. */
  STOP_TEST_PATTERN: "stop_led_test_pattern",
  /** Open the preview session: popup + twin, main window hidden. Changes no light. */
  OPEN_PREVIEW: "open_preview",
  /** End the session from any state; every window it opened goes, the main window comes back. */
  CLOSE_PREVIEW: "close_preview",
  /** Hide or show the popup while the session stays open. */
  SET_POPUP_HIDDEN: "set_preview_popup_hidden",
  /** The session as it is; the popup reads it on mount, then follows `preview://session`. */
  GET_SESSION: "get_preview_session",
  /** Hide or show the twin while the session stays open. */
  SET_TWIN_HIDDEN: "set_preview_twin_hidden",
  /** The session's twin takes its frames on a channel; answers the current layout. */
  SUBSCRIBE_TWIN_FRAMES: "subscribe_twin_frames",
  /** Play a scene, Ambilight on the user's settings for it; switches a playing one in place. */
  START_SCENE: "start_preview_scene",
  /** Stop the scene; the mode it interrupted comes back. */
  STOP_SCENE: "stop_preview_scene",
  /** The playing scene's brightness, live and never saved. */
  SET_SCENE_BRIGHTNESS: "set_preview_scene_brightness",
} as const;

export type PreviewCommandId = (typeof PREVIEW_COMMANDS)[keyof typeof PREVIEW_COMMANDS];

// ---------------------------------------------------------------------------
// Test pattern kinds
// ---------------------------------------------------------------------------

/**
 * Ordered list of synthetic test pattern kinds. `LedTestPattern` carries the
 * per-kind payload; this list + `LedTestPatternKind` are its discriminator.
 */
export const LED_TEST_PATTERN_KIND = [
  "solid",
  "chase",
  "rainbow",
  "spiral",
  "gamut",
  "channelProbe",
] as const;

export type LedTestPatternKind = (typeof LED_TEST_PATTERN_KIND)[number];

/**
 * Discriminated union of test patterns (discriminator `kind`).
 *
 * - `solid` / `chase` carry an explicit RGB triple (0..255 per channel).
 * - `rainbow` / `spiral` / `gamut` are fully procedural — the Rust generator
 *   owns their colour math, so no payload travels with them.
 * - `channelProbe` paints the whole strip pure red / green / blue for wire
 *   slot 0 / 1 / 2, under the identity colour order whatever the saved
 *   `ledColorOrder` is, so the user can report which colour each slot shows.
 *   Chip type, firmware profile and colour correction still apply. A slot
 *   above 2 is refused with `LED_TEST_PATTERN_INVALID_PARAMS`. Not offered by
 *   the pattern picker — a probe without a slot is not a probe.
 */
export type LedTestPattern =
  | { kind: "solid"; r: number; g: number; b: number }
  | { kind: "chase"; r: number; g: number; b: number }
  | { kind: "rainbow" }
  | { kind: "spiral" }
  | { kind: "gamut" }
  | { kind: "channelProbe"; slot: 0 | 1 | 2 };

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
   * default (USB-first).
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
 * `previewOnly` is `true` when no physical sink took the frames (no connected
 * device) — only an open preview twin shows them — surfaced together with
 * `LED_TEST_PATTERN_PREVIEW_ONLY`.
 */
export interface LedTestPatternResult {
  active: boolean;
  previewOnly: boolean;
  status: CommandStatusOf<LedTestStatusCode>;
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/** The test scenes, in the order the popup offers them. */
export const SCENE_KINDS = ["edgeTour", "spiral", "sunset", "colorFields", "letterbox"] as const;

export type SceneKind = (typeof SCENE_KINDS)[number];

// ---------------------------------------------------------------------------
// Preview session
// ---------------------------------------------------------------------------

interface LiveSessionFields {
  /** Display the twin covers — the one Ambilight captures. */
  displayId: DisplayId;
  popupHidden: boolean;
  /** The popup's switch. Never saved: every session opens with the twin. */
  twinHidden: boolean;
  /** Off screen while Ambilight captures, whatever the switch says, where
   * nothing can keep the twin out of the capture (Linux, Windows before 2004). */
  twinHeldForCapture: boolean;
}

/** The session as Rust holds it. Never persisted: nothing starts on its own. */
export type PreviewSession =
  | { state: "closed" }
  | ({ state: "live" } & LiveSessionFields)
  | ({
      state: "scene";
      scene: SceneKind;
      /** The scene's own brightness, 0..1; never saved. */
      sceneBrightness: number;
    } & LiveSessionFields);

/** The layout the twin draws: the one the running mode uses, which during a
 *  LED Setup test is the layout being edited, not the saved one. */
export interface TwinLayout {
  displayId: DisplayId;
  /** Grows with every new layout and never resets; a frame names the one current when it was sent. */
  layoutRevision: number;
  /** `null` with no strip set up: the twin draws no LEDs. */
  leds: LedCalibrationConfig | null;
}

/** What the twin passes to `subscribe_twin_frames`: a Tauri `Channel` of raw
 *  frames, named by shape so the contracts stay free of the Tauri API. */
export interface TwinFrameChannel {
  onmessage: (frame: ArrayBuffer) => void;
  /** How a channel crosses `invoke` (`__CHANNEL__:<id>`); a plain object without it fails in Rust. */
  toJSON(): string;
}

/** Result of `subscribe_twin_frames`. */
export interface TwinSubscribeResult {
  /** `null` when the caller is not the open session's twin. */
  layout: TwinLayout | null;
  status: CommandStatusOf<TwinSubscribeStatusCode>;
}

/**
 * One twin frame on the channel: a little-endian header of four u32 — seq,
 * the layout revision current when it was sent, LED count, lamp count — then
 * packed RGB for every strip LED
 * and every Hue lamp, as the light looks on a screen. Pinned by
 * `features/preview/__tests__/twinFrame.golden.json`, which Rust reads too.
 */
export const TWIN_FRAME = {
  HEADER_BYTES: 16,
  SEQ_OFFSET: 0,
  REVISION_OFFSET: 4,
  LED_COUNT_OFFSET: 8,
  LAMP_COUNT_OFFSET: 12,
} as const;

/** Payload for `set_preview_popup_hidden`. */
export interface SetPreviewPopupHiddenPayload {
  hidden: boolean;
}

/** Payload for `set_preview_twin_hidden`. */
export interface SetPreviewTwinHiddenPayload {
  hidden: boolean;
}

/** Payload for `start_preview_scene`. */
export interface StartPreviewScenePayload {
  kind: SceneKind;
}

/** Payload for `set_preview_scene_brightness`; outside 0..1 it is clamped. */
export interface SetPreviewSceneBrightnessPayload {
  brightness: number;
}

/** Result of every session command. */
export interface PreviewSessionResult {
  session: PreviewSession;
  status: CommandStatusOf<PreviewSessionStatusCode>;
}

// ---------------------------------------------------------------------------
// Status codes — typed constants, never raw strings.
// ---------------------------------------------------------------------------

export const LED_TEST_STATUS = {
  /** Pattern accepted and now streaming to the configured sink(s). */
  PATTERN_STARTED: "LED_TEST_PATTERN_STARTED",
  /**
   * Pattern accepted but no physical sink received frames (e.g. no device
   * connected); only an open preview twin shows it.
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
  /** A preview scene owns the lights; nothing was started. */
  PATTERN_SCENE_ACTIVE: "LED_TEST_PATTERN_SCENE_ACTIVE",
} as const;

export type LedTestStatusCode = (typeof LED_TEST_STATUS)[keyof typeof LED_TEST_STATUS];

export const PREVIEW_STATUS = {
  /** Popup and twin up, main window hidden if it was visible. */
  OPENED: "PREVIEW_OPENED",
  /** A session was already open; its popup is shown and focused. */
  ALREADY_OPEN: "PREVIEW_ALREADY_OPEN",
  /** Session ended; every preview window is gone, a stray from an earlier failure too. */
  CLOSED: "PREVIEW_CLOSED",
  /** Nothing to close or change: no session is open and no preview window is left. */
  NOT_OPEN: "PREVIEW_NOT_OPEN",
  /** The popup was hidden or shown. */
  POPUP_UPDATED: "PREVIEW_POPUP_UPDATED",
  /** The twin was hidden or shown; shown, it gets a fresh frame at once. */
  TWIN_UPDATED: "PREVIEW_TWIN_UPDATED",
  /** The twin's channel is registered; the layout comes with the answer. */
  TWIN_SUBSCRIBED: "PREVIEW_TWIN_SUBSCRIBED",
  /** The displays could not be read, or a window could not be built; whatever
   * was built is destroyed again. A saved display that is gone is not a failure:
   * the twin goes where the capture falls back to. */
  OPEN_FAILED: "PREVIEW_OPEN_FAILED",
  /** A window survived its destroy; `details` names it. The twin is click-through
   * and undecorated, so a survivor would sit over the display undismissable. */
  CLOSE_FAILED: "PREVIEW_CLOSE_FAILED",
  /** The scene plays and Ambilight runs for it. */
  SCENE_STARTED: "PREVIEW_SCENE_STARTED",
  /** The scene stopped and the mode it interrupted is back. */
  SCENE_STOPPED: "PREVIEW_SCENE_STOPPED",
  /** The scene's brightness changed. */
  SCENE_UPDATED: "PREVIEW_SCENE_UPDATED",
  /** The session is open and no scene plays. */
  SCENE_NOT_RUNNING: "PREVIEW_SCENE_NOT_RUNNING",
  /** Nothing to light: no strip or WLED panel, and no Hue stream already up. */
  SCENE_NO_OUTPUT: "PREVIEW_SCENE_NO_OUTPUT",
  /** Screen recording is not allowed, so Ambilight cannot see the scene. */
  SCENE_CAPTURE_DENIED: "PREVIEW_SCENE_CAPTURE_DENIED",
  /** The scene window or Ambilight did not start; `details` says which. The lights are as before. */
  SCENE_START_FAILED: "PREVIEW_SCENE_START_FAILED",
  /** A LED Setup or Devices test pattern owns the lights. */
  SCENE_TEST_PATTERN_ACTIVE: "PREVIEW_SCENE_TEST_PATTERN_ACTIVE",
  /** The display the session is on is gone. */
  DISPLAY_NOT_FOUND: "PREVIEW_DISPLAY_NOT_FOUND",
  /** The lights did not go back to the mode the scene interrupted: its output went away and they
   * are off, or the stop itself was rejected and the scene may still be playing. */
  RESTORE_FAILED: "PREVIEW_RESTORE_FAILED",
} as const;

export type PreviewStatusCode = (typeof PREVIEW_STATUS)[keyof typeof PREVIEW_STATUS];

/** What the session commands answer: every preview code but the twin's own. */
export type PreviewSessionStatusCode = Exclude<PreviewStatusCode, typeof PREVIEW_STATUS.TWIN_SUBSCRIBED>;

/** What `subscribe_twin_frames` answers. */
export type TwinSubscribeStatusCode = typeof PREVIEW_STATUS.TWIN_SUBSCRIBED | typeof PREVIEW_STATUS.NOT_OPEN;

/** Thrown as `Err("CODE: detail")` before any status object is built, so a
 * `switch` on {@link PREVIEW_STATUS} will never see them. */
export const PREVIEW_COMMAND_ERRORS = {
  SESSION_LOCK_FAILED: "PREVIEW_SESSION_LOCK_FAILED",
} as const;

export type PreviewCommandErrorCode =
  (typeof PREVIEW_COMMAND_ERRORS)[keyof typeof PREVIEW_COMMAND_ERRORS];

// ---------------------------------------------------------------------------
// Window labels + event names
// ---------------------------------------------------------------------------

/** Label prefix for the twin window. The suffix is a counter, not the display
 * id: a label is reserved until its destroy completes, so a reopen right after
 * a close would collide on a fixed one. */
export const LED_TWIN_OVERLAY_LABEL_PREFIX = "led-twin-overlay-" as const;

/** Label prefix for the session's control popup; a counter follows, as for the twin. */
export const LED_CONTROL_POPUP_LABEL_PREFIX = "led-control-popup-" as const;

/** Label prefix for the scene window; a counter follows, as for the twin. */
export const LED_PREVIEW_SCENE_LABEL_PREFIX = "led-preview-scene-" as const;

/** `TwinLayout`, to the twin, when the running mode's layout changes. */
export const PREVIEW_TWIN_LAYOUT_EVENT = "preview://twin-layout" as const;

/** `PreviewSession`, to the popup and the scene window, when it changes while
 * the session is open. The main window gets nothing: it learns the session
 * ended by being shown again. */
export const PREVIEW_SESSION_EVENT = "preview://session" as const;

export const PREVIEW_EVENTS = {
  TWIN_LAYOUT: PREVIEW_TWIN_LAYOUT_EVENT,
  SESSION: PREVIEW_SESSION_EVENT,
} as const;

export type PreviewEventName = (typeof PREVIEW_EVENTS)[keyof typeof PREVIEW_EVENTS];
