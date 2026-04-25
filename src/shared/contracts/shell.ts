import type { LedCalibrationConfig } from "./calibration";
import type { ColorCorrectionConfig, FirmwareProfile, LedChipType } from "./device";
import type { DisplayId } from "./display";
import type { LightingModeConfig } from "../../features/mode/model/contracts";
import type {
  HueBridgeSummary,
  HueCredentialStatus,
  HueIntensityPreset,
  HueOnboardingStep,
  HueRuntimeTarget,
} from "./hue";
import type { RoomMapConfig } from "./roomMap";

/**
 * Shell Contracts
 *
 * Single source of truth for tray menu IDs, sidebar section IDs,
 * and persisted shell state fields.
 *
 * All consumer modules MUST import from here — never use magic strings.
 */

// ---------------------------------------------------------------------------
// Shell Commands (Tauri invoke targets)
// ---------------------------------------------------------------------------

/** Canonical Tauri command names for shell-level operations */
export const SHELL_COMMANDS = {
  UPDATE_TRAY_LABELS: "update_tray_labels",
} as const;

export type ShellCommand = (typeof SHELL_COMMANDS)[keyof typeof SHELL_COMMANDS];

// ---------------------------------------------------------------------------
// Tray Menu IDs
// ---------------------------------------------------------------------------

/** Canonical identifiers for tray menu items */
export const TRAY_MENU_IDS = {
  OPEN_SETTINGS: "open-settings",
  STATUS_INDICATOR: "status-indicator",
  LIGHTS_OFF: "tray-lights-off",
  RESUME_LAST_MODE: "tray-resume-last-mode",
  SOLID_COLOR: "tray-solid-color",
  QUIT: "quit",
} as const;

export type TrayMenuId = (typeof TRAY_MENU_IDS)[keyof typeof TRAY_MENU_IDS];

// ---------------------------------------------------------------------------
// Settings Sidebar Section IDs
// ---------------------------------------------------------------------------

/** Main navigation section identifiers */
export const SECTION_IDS = {
  LIGHTS: "lights",
  LED_SETUP: "led-setup",
  DEVICES: "devices",
  SYSTEM: "system",
  ROOM_MAP: "room-map",
} as const;

export type SectionId = (typeof SECTION_IDS)[keyof typeof SECTION_IDS];

/** Ordered list of main navigation sections */
export const SECTION_ORDER: SectionId[] = [
  SECTION_IDS.LIGHTS,
  SECTION_IDS.LED_SETUP,
  SECTION_IDS.DEVICES,
  SECTION_IDS.ROOM_MAP,
  SECTION_IDS.SYSTEM,
];

// ---------------------------------------------------------------------------
// Persisted Shell State Contract
// ---------------------------------------------------------------------------

/**
 * Current persisted state schema version.
 *
 * Bumped whenever a non-additive change to `ShellState` requires a migration
 * step on load (renamed/removed fields, semantic changes to existing data).
 * Pure additive changes (new optional fields with backend-provided defaults)
 * do NOT bump the version — the legacy spread-merge in `loadShellState` keeps
 * existing user data compatible.
 *
 * v1.5 introduces this field at value `1`; absent on disk ⇒ treat as legacy
 * pre-versioning state (also `1`, since v1.4 and earlier match the same
 * additive shape).
 */
export const SHELL_STATE_SCHEMA_VERSION = 1 as const;

/** Shape of shell state persisted to disk via plugin-store */
export interface ShellState {
  /**
   * Persisted-state schema version (v1.5+). Defaults to
   * `SHELL_STATE_SCHEMA_VERSION` for fresh state and during legacy migration
   * write-back. Future bumps run a one-shot upgrade in `loadShellState`.
   */
  schemaVersion: number;
  /** Window geometry (pixels) */
  windowWidth: number | null;
  windowHeight: number | null;
  /** Window position — null means use OS default / centered */
  windowX: number | null;
  windowY: number | null;
  /** Last active sidebar section */
  lastSection: SectionId;
  /** Whether the user has already seen the "minimized to tray" one-time hint */
  trayHintShown: boolean;
  /** Whether to launch at OS login */
  startupEnabled: boolean;
  /**
   * User-selected language code (e.g. "en", "tr").
   * Absent on first launch → languagePolicy defaults to "en" per I18N-02.
   */
  language?: string;
  /**
   * Last port name that connected successfully.
   * Updated only after a successful connection attempt.
   */
  lastSuccessfulPort?: string;
  /**
   * Last saved LED calibration model.
   * Absent until user completes calibration flow.
   */
  ledCalibration?: LedCalibrationConfig;
  /**
   * Last selected LED lighting mode state.
   * Absent until user explicitly changes mode settings.
   */
  lightingMode?: LightingModeConfig;
  /**
   * Last selected runtime output target set.
   * Defaults to USB-first when absent.
   */
  lastOutputTargets?: HueRuntimeTarget[];
  /**
   * Last bridge that successfully completed Hue onboarding checks.
   */
  lastHueBridge?: HueBridgeSummary;
  /**
   * Persisted Hue pairing username (application key) for reconnect-safe reuse.
   */
  hueAppKey?: string;
  /**
   * Persisted Hue client key required for entertainment streaming.
   */
  hueClientKey?: string;
  /**
   * Last selected Hue entertainment area.
   */
  lastHueAreaId?: string;
  /**
   * Last completed onboarding step for resume flow continuity.
   */
  hueOnboardingStep?: HueOnboardingStep;
  /**
   * User-defined screen region overrides per entertainment area.
   * Keyed by area ID → channel index → region string ("left" | "right" | "top" | "bottom" | "center").
   */
  hueChannelRegionOverrides?: Record<string, Record<number, string>>;
  /**
   * Cached credential health line shown in Hue settings.
   */
  hueCredentialStatus?: HueCredentialStatus;
  /**
   * Persisted room map configuration.
   * Absent until the user first opens the room map editor.
   */
  roomMap?: RoomMapConfig;
  /**
   * Monotonically increasing integer, incremented on each room map save.
   * Allows downstream consumers to detect stale in-memory state.
   */
  roomMapVersion?: number;
  /** Room map editor grid visibility */
  roomMapShowGrid?: boolean;
  /** Room map editor grid stroke width (px) */
  roomMapGridStrokeWidth?: number;
  /** Room map editor background image opacity (0-100) */
  roomMapBackgroundOpacity?: number;
  /** Active UI layout mode (compact tray panel vs full settings window) */
  uiMode?: UIMode;
  /**
   * Last known full-mode window size (logical pixels).
   * Captured when switching out of full mode so the next compact→full
   * restore returns to the user's preferred full-mode dimensions.
   */
  lastFullSize?: { width: number; height: number };
  /**
   * User-facing intensity preset (v1.4) that maps to an EWMA coefficient
   * on the Hue runtime pump. Absent ⇒ `DEFAULT_HUE_INTENSITY_PRESET`.
   */
  lightingIntensityPreset?: HueIntensityPreset;
  /**
   * Per-channel color correction (v1.4 G4) applied before sinks. Absent ⇒
   * `DEFAULT_COLOR_CORRECTION` (gamma 2.2 / 6500K / saturation 1.0).
   */
  colorCorrection?: ColorCorrectionConfig;
  /**
   * Preferred firmware profile (v1.4 G11). Absent ⇒ backend falls back to
   * `LUMASYNC_V1` on successful handshake, then `ADALIGHT` if the handshake
   * fails, so plain Adalight sketches continue to light up.
   */
  firmwareProfile?: FirmwareProfile;
  /**
   * Display chosen for ambilight capture (v1.4 GAP 2). Absent ⇒ capture
   * pipeline uses the OS primary display as it does today.
   */
  selectedDisplayId?: DisplayId;
  /**
   * Whether the OS-level notification surface is enabled (v1.4 Platform
   * GAP). Absent ⇒ notifications disabled until the user opts in.
   */
  notificationsEnabled?: boolean;
  /**
   * v1.5 W2-B4 — first-run onboarding completion flag. When `true`,
   * `OnboardingFlow` skips render entirely; when `undefined` / `false`,
   * the 3-step inline progressive banner walks the user through
   * picking a mode → connecting devices → calibrating LEDs. Set to
   * `true` once the user finishes (or explicitly skips) the final step.
   *
   * Additive — no schemaVersion bump because the absence of the field
   * naturally degrades to "show onboarding for first-launch users",
   * which is exactly the legacy default for everyone upgrading from
   * v1.4 (they will see the banner once and dismiss it).
   */
  hasCompletedOnboarding?: boolean;
  /**
   * LED chip type for the USB serial sink (v1.5 G3). Controls the per-pixel
   * byte layout: `ws2812b-grb` (3 bytes, default) or `sk6812-rgbw` (4 bytes
   * with host-side W = min(R,G,B) extraction). Absent ⇒ `WS2812B_GRB`.
   */
  selectedChipType?: LedChipType;
  /**
   * Update channel preference (v1.5 W2-C6). Defaults to `"stable"` when
   * absent — `"beta"` opts the user into the prerelease feed served from
   * `latest-beta.json` alongside the canonical `latest.json`.
   *
   * The channel is read at startup by `useAutoUpdater` so it can render the
   * active channel badge inside `<UpdateModal />`. Endpoint selection is a
   * fallback list today (Tauri updater walks both endpoints in order); a
   * future Rust-side dynamic `app.updater_builder().endpoints(...)` rewrite
   * is tracked behind Platform GAP 16 — the contract field lands first so
   * the toggle UI and persisted state ship without blocking on it.
   *
   * Additive — `schemaVersion` is not bumped because absence naturally
   * degrades to `"stable"` which matches v1.4 behaviour exactly.
   */
  updateChannel?: UpdateChannel;
}

/** Default shell state for first launch */
export const DEFAULT_SHELL_STATE: ShellState = {
  schemaVersion: SHELL_STATE_SCHEMA_VERSION,
  windowWidth: null,
  windowHeight: null,
  windowX: null,
  windowY: null,
  lastSection: SECTION_IDS.LIGHTS,
  trayHintShown: false,
  startupEnabled: false,
};

// ---------------------------------------------------------------------------
// Store Keys
// ---------------------------------------------------------------------------

/** Key used by plugin-store to persist shell state */
export const SHELL_STORE_KEY = "shell-state";

// ---------------------------------------------------------------------------
// UI Mode (compact / full)
// ---------------------------------------------------------------------------

/** Window layout mode — compact for tray-first quick controls, full for settings */
export type UIMode = "compact" | "full";

/**
 * Auto-update release channel (v1.5 W2-C6).
 *
 * - `"stable"` — production releases tagged `vX.Y.Z` (no suffix). Served
 *   from `latest.json`. Default for fresh installs and upgrades from
 *   v1.4 where the field is absent.
 * - `"beta"` — prereleases tagged `vX.Y.Z-beta.N`. Served from
 *   `latest-beta.json`. Opt-in via the Settings → System pane.
 *
 * Endpoint mapping today is a single canonical `latest.json` inside
 * `tauri.conf.json`; a follow-up Rust-side dynamic
 * `app.updater_builder().endpoints(...)` will route opted-in installs to
 * `latest-beta.json` once the prerelease publishing flow is exercised.
 */
export type UpdateChannel = "stable" | "beta";

/** Default update channel for fresh installs / unset state. */
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = "stable";

/** Logical pixel dimensions for each UI mode */
export const UI_MODE_SIZES: Readonly<Record<UIMode, { width: number; height: number }>> = {
  compact: { width: 320, height: 480 },
  full: { width: 900, height: 620 },
};

/**
 * Per-mode minimum window size. Applied dynamically via `setMinSize` when
 * `resizeToMode` runs so each mode enforces a floor that keeps its own layout
 * readable at every resolution.
 *
 * - Compact min (300×420): tight but keeps tray-style controls usable.
 * - Full min (800×560): derived from the Lights mode-strip container-query
 *   breakpoints — at ≥800px the strip is ≥460px wide, so mode title + subtitle
 *   stay visible (only the decorative ⌥1-3 kb pill sheds below 580px mstrip).
 */
export const UI_MODE_MIN_SIZES: Readonly<Record<UIMode, { width: number; height: number }>> = {
  compact: { width: 300, height: 420 },
  full: { width: 800, height: 560 },
};

// ---------------------------------------------------------------------------
// Keybind Registry (G9 — launch-credibility fix)
// ---------------------------------------------------------------------------

/**
 * Canonical identifiers for every global keyboard shortcut the shell wires
 * up. Consumers (`useGlobalKeybinds`, `StatusBar`, `LightsSection`) import
 * from this registry instead of hardcoding `⌥1` / `Alt+1` strings, so a
 * badge rendered in the UI is always backed by a real keydown handler.
 *
 * `event.code` is used for detection (not `event.key`) to survive the TR
 * keyboard layout — on `AltGr`/`Alt`+digit combinations the `event.key`
 * value becomes a punctuation symbol (`¡`, `™`, `£`), but `event.code`
 * stays stable at `Digit1` / `Digit2` / `Digit3` / `Comma`.
 */
export const KEYBIND_ACTIONS = {
  MODE_OFF: "mode-off",
  MODE_AMBILIGHT: "mode-ambilight",
  MODE_SOLID: "mode-solid",
  OPEN_SETTINGS: "open-settings",
} as const;

export type KeybindAction = (typeof KEYBIND_ACTIONS)[keyof typeof KEYBIND_ACTIONS];

/** Platform variants for keybind label + detection. */
export type KeybindPlatform = "macos" | "default";

/**
 * Per-action keybind definition. `code` matches `KeyboardEvent.code`, while
 * `badge` is the visible label inside the `<kbd>` cluster and `labelKey`
 * feeds the i18n aria-label.
 */
export interface KeybindDefinition {
  /**
   * Modifier requirement. `alt` = Option on macOS / Alt on Windows+Linux,
   * `meta` = Command on macOS / Win key on Windows (we don't use meta on
   * non-mac — `OPEN_SETTINGS` falls back to `ctrl+,` via the `default`
   * variant).
   */
  modifier: "alt" | "meta" | "ctrl";
  /** `KeyboardEvent.code` value — stable across keyboard layouts. */
  code: string;
  /** Single-character chunks that render as `<kbd>` badges, in order. */
  badge: string[];
}

/**
 * Platform-aware keybind map. macOS uses `⌥1/⌥2/⌥3` + `⌘,`; Windows/Linux
 * show `Alt+1/Alt+2/Alt+3` + `Ctrl+,` with matching `Alt` / `Control`
 * modifier requirements.
 */
export const KEYBIND_REGISTRY: Readonly<
  Record<KeybindPlatform, Readonly<Record<KeybindAction, KeybindDefinition>>>
> = {
  macos: {
    [KEYBIND_ACTIONS.MODE_OFF]: { modifier: "alt", code: "Digit1", badge: ["⌥", "1"] },
    [KEYBIND_ACTIONS.MODE_AMBILIGHT]: { modifier: "alt", code: "Digit2", badge: ["⌥", "2"] },
    [KEYBIND_ACTIONS.MODE_SOLID]: { modifier: "alt", code: "Digit3", badge: ["⌥", "3"] },
    [KEYBIND_ACTIONS.OPEN_SETTINGS]: { modifier: "meta", code: "Comma", badge: ["⌘", ","] },
  },
  default: {
    [KEYBIND_ACTIONS.MODE_OFF]: { modifier: "alt", code: "Digit1", badge: ["Alt", "1"] },
    [KEYBIND_ACTIONS.MODE_AMBILIGHT]: { modifier: "alt", code: "Digit2", badge: ["Alt", "2"] },
    [KEYBIND_ACTIONS.MODE_SOLID]: { modifier: "alt", code: "Digit3", badge: ["Alt", "3"] },
    [KEYBIND_ACTIONS.OPEN_SETTINGS]: { modifier: "ctrl", code: "Comma", badge: ["Ctrl", ","] },
  },
} as const;

/**
 * Detect the platform variant that drives badge labels and modifier keys.
 * Falls back to `"default"` (Windows/Linux layout) when `navigator` is
 * unavailable (SSR / older jsdom).
 */
export function resolveKeybindPlatform(): KeybindPlatform {
  if (typeof navigator === "undefined") return "default";
  const ua = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  return /mac|iphone|ipod|ipad/.test(ua) ? "macos" : "default";
}

/** Look up the per-platform definition for a keybind action. */
export function getKeybindDefinition(
  action: KeybindAction,
  platform: KeybindPlatform = resolveKeybindPlatform(),
): KeybindDefinition {
  return KEYBIND_REGISTRY[platform][action];
}
