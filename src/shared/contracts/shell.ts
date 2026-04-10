import type { LedCalibrationConfig } from "../../features/calibration/model/contracts";
import type { LightingModeConfig } from "../../features/mode/model/contracts";
import type {
  HueBridgeSummary,
  HueCredentialStatus,
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
  SECTION_IDS.SYSTEM,
  SECTION_IDS.ROOM_MAP,
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
// Window Constraints
// ---------------------------------------------------------------------------

export const WINDOW_MIN_WIDTH = 720;
export const WINDOW_MIN_HEIGHT = 480;
