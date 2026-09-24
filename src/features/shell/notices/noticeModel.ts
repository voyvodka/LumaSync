/**
 * The shell's notice queue: every status message the shell raises, in one
 * ordered list rendered through one slot. The reasoning — why one slot, why
 * conditions never time out, why the order is what it is — is in
 * docs/architecture/ui-and-shell.md ("Every shell notice goes through one
 * queue and one slot").
 */

import type { TranslationKey } from "@/features/i18n/catalogue";
import type { DeviceCategory } from "@/features/settings/sections/DeviceSection";
import { SECTION_IDS, type SectionId, type UIMode } from "@/shared/contracts/shell";

export const NOTICE_SEVERITY = {
  ERROR: "error",
  WARNING: "warning",
  INFO: "info",
} as const;

export type NoticeSeverity = (typeof NOTICE_SEVERITY)[keyof typeof NOTICE_SEVERITY];

/** Spoken and read ahead of every message, so severity never rests on colour alone. */
export const NOTICE_SEVERITY_LABEL: Record<NoticeSeverity, TranslationKey> = {
  [NOTICE_SEVERITY.ERROR]: "shell:notices.severity.error",
  [NOTICE_SEVERITY.WARNING]: "shell:notices.severity.warning",
  [NOTICE_SEVERITY.INFO]: "shell:notices.severity.info",
};

/**
 * A condition describes a state that is still true and leaves when the state
 * does; an event reports something that happened and leaves on its source's
 * timer (held while the user is reading it) or its ×.
 */
export type NoticeKind = "condition" | "event";

/** Queue tiers, highest priority first. */
export const NOTICE_TIER = {
  ERROR_CONDITION: 1,
  ERROR_EVENT: 2,
  WARNING: 3,
  INFO: 4,
} as const;

export type NoticeTier = (typeof NOTICE_TIER)[keyof typeof NOTICE_TIER];

export const SHELL_NOTICE_IDS = {
  CAPTURE_PERMISSION: "capture-permission",
  CAPTURE_STALLED: "capture-stalled",
  OUTPUT_NONE: "output-none",
  CALIBRATION_REQUIRED: "calibration-required",
  START_FAILED: "start-failed",
  STOP_FAILED: "stop-failed",
  PREVIEW_OPEN_FAILED: "preview-open-failed",
  HUE_LEFT_OUT: "hue-left-out",
  HUE_BOOT_RETRY: "hue-boot-retry",
  USB_DISCONNECTED: "usb-disconnected",
  USB_UNSUPPORTED: "usb-unsupported",
  HUE_COLOR: "hue-color",
  OUTPUT_CHECKING: "output-checking",
  LED_SETUP_NEXT: "led-setup-next",
  ONBOARDING: "onboarding",
  UPDATE_CHECK_FAILED: "update-check-failed",
  SETTINGS_NOT_SAVED: "settings-not-saved",
} as const;

export type ShellNoticeId = (typeof SHELL_NOTICE_IDS)[keyof typeof SHELL_NOTICE_IDS];

/**
 * A screen that shows a condition on its own surface. A notice that names one
 * in `shownBy` stays out of the strip while that screen is on view, and comes
 * back as the same occurrence — a × still holds — once the user leaves it.
 */
export const NOTICE_VIEW = {
  /** Full mode, Devices → Hue: the bridge card and channel map. */
  DEVICES_HUE: "devices/hue",
} as const;

export type NoticeView = (typeof NOTICE_VIEW)[keyof typeof NOTICE_VIEW];

export interface NoticeViewInput {
  uiMode: UIMode;
  activeSection: SectionId;
  /** The category the mounted Devices page shows, or `null` when it is not mounted. */
  visibleDeviceCategory: DeviceCategory | null;
}

/** The screen on view, if it is one a notice can defer to. Compact has none. */
export function currentNoticeView({ uiMode, activeSection, visibleDeviceCategory }: NoticeViewInput): NoticeView | null {
  if (uiMode !== "full" || activeSection !== SECTION_IDS.DEVICES) return null;
  return visibleDeviceCategory === "hue" ? NOTICE_VIEW.DEVICES_HUE : null;
}

export function isShownByView(notice: Pick<ShellNotice, "shownBy">, view: NoticeView | null): boolean {
  return view !== null && notice.shownBy === view;
}

export interface NoticeAction {
  label: string;
  onClick: () => void;
  /** Goes to another screen, which the strip marks with a trailing arrow. */
  navigates?: boolean;
  /** Keeps the button on screen, inert, while its work is in flight. */
  pending?: boolean;
  testId?: string;
}

export interface ShellNotice {
  id: ShellNoticeId;
  tier: NoticeTier;
  severity: NoticeSeverity;
  kind: NoticeKind;
  /**
   * One sentence — the strip's only text. Compact cuts it with an ellipsis
   * and offers the rest behind the toggle, so lead with what happened.
   */
  message: string;
  /** Onboarding's "1/3". */
  step?: string;
  action?: NoticeAction;
  /**
   * A second way out, shown only where the strip has room: full mode, or an
   * expanded compact slot — never the compact line, which has room for one.
   */
  secondaryAction?: NoticeAction;
  /** Shows a ×. Events always have one; of the conditions, only onboarding and the failed settings save. */
  dismissible: boolean;
  /** Runs after the queue hides the notice — onboarding persists its completion here. */
  onDismiss?: () => void;
  /**
   * The value the source raised. A new identity, or the notice leaving and
   * coming back, is a new occurrence: a × hides one occurrence, not the id.
   */
  source: unknown;
  testId: string;
  data?: Record<`data-${string}`, string>;
  /** The screen that already says this; see `NOTICE_VIEW`. */
  shownBy?: NoticeView;
}

/** Tier first, then the order the builder listed them in. Stable. */
export function orderNotices<T extends Pick<ShellNotice, "tier">>(notices: readonly T[]): T[] {
  return notices
    .map((notice, index) => ({ notice, index }))
    .sort((a, b) => a.notice.tier - b.notice.tier || a.index - b.index)
    .map(({ notice }) => notice);
}
