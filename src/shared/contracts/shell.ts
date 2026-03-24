import type { LedCalibrationConfig } from "../../features/calibration/model/contracts";
import type { LightingModeConfig } from "../../features/mode/model/contracts";
import type {
  HueBridgeSummary,
  HueCredentialStatus,
  HueOnboardingStep,
  HueRuntimeTarget,
} from "./hue";

/**
 * Shell Contracts
 *
 * Single source of truth for tray menu IDs, sidebar section IDs,
 * and persisted shell state fields.
 *
 * All consumer modules MUST import from here — never use magic strings.
 */

// ---------------------------------------------------------------------------
// Tray Menu IDs
// ---------------------------------------------------------------------------

/** Canonical identifiers for tray menu items */
export const TRAY_MENU_IDS = {
  OPEN_SETTINGS: "open-settings",
  STATUS_INDICATOR: "status-indicator",
  STARTUP_TOGGLE: "startup-toggle",
  QUIT: "quit",
} as const;

export type TrayMenuId = (typeof TRAY_MENU_IDS)[keyof typeof TRAY_MENU_IDS];

// ---------------------------------------------------------------------------
// Settings Sidebar Section IDs
// ---------------------------------------------------------------------------

/** Phase 1 baseline sidebar section identifiers */
export const SECTION_IDS = {
  GENERAL: "general",
  STARTUP_TRAY: "startup-tray",
  LANGUAGE: "language",
  ABOUT_LOGS: "about-logs",
  TELEMETRY: "telemetry",
  DEVICE: "device",
  CALIBRATION: "calibration",
} as const;

export type SectionId = (typeof SECTION_IDS)[keyof typeof SECTION_IDS];

/** Ordered list of sidebar sections for rendering */
export const SECTION_ORDER: SectionId[] = [
  SECTION_IDS.GENERAL,
  SECTION_IDS.STARTUP_TRAY,
  SECTION_IDS.LANGUAGE,
  SECTION_IDS.ABOUT_LOGS,
  SECTION_IDS.TELEMETRY,
  SECTION_IDS.DEVICE,
  SECTION_IDS.CALIBRATION,
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
}

/** Default shell state for first launch */
export const DEFAULT_SHELL_STATE: ShellState = {
  windowWidth: null,
  windowHeight: null,
  windowX: null,
  windowY: null,
  lastSection: SECTION_IDS.GENERAL,
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
