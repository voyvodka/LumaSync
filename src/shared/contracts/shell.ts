import type { LedCalibrationConfig } from "./calibration";
import type { ColorCorrectionConfig, FirmwareProfile } from "./device";
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

/** Shape of shell state persisted to disk via plugin-store */
export interface ShellState {
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
}

/** Default shell state for first launch */
export const DEFAULT_SHELL_STATE: ShellState = {
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
