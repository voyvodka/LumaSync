/**
 * StatusBar — fixed-bottom chrome row that sits below the content slot.
 *
 * Mirrors the title bar at the top: full width, dark amber language, always
 * visible regardless of UI mode. Shows pill indicators for the runtime
 * subsystems (CAP / USB / HUE) and — in full mode only — the keyboard hint
 * cluster and version pill on the right.
 *
 * Compact mode hides the keyboard hints + version (no room in a 320px tray
 * panel) and uses a slightly tighter font + padding, matching mockup
 * `10-compact.html`.
 *
 * Keyboard hint badges are derived from `KEYBIND_REGISTRY` so every label
 * shown here is backed by a matching handler in `useGlobalKeybinds`. Edit
 * that registry instead of hand-patching `⌥1` / `Alt+1` strings.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { APP_VERSION } from "../../shared/constants/app";
import {
  KEYBIND_ACTIONS,
  type KeybindAction,
  getKeybindDefinition,
  resolveKeybindPlatform,
} from "../../shared/contracts/shell";

export const STATUS_BAR_HEIGHT_FULL_PX = 24;
export const STATUS_BAR_HEIGHT_COMPACT_PX = 22;

export function statusBarHeightPx(uiMode: "full" | "compact"): number {
  return uiMode === "compact" ? STATUS_BAR_HEIGHT_COMPACT_PX : STATUS_BAR_HEIGHT_FULL_PX;
}

export type StatusKind = "ok" | "active" | "idle" | "off";

export interface StatusItem {
  /** Short uppercase label, e.g. "CAP", "USB", "HUE". */
  label: string;
  /** Short uppercase value, e.g. "OK", "STREAMING", "—". */
  state: string;
  /** Drives the dot + value color. */
  kind: StatusKind;
}

interface StatusBarProps {
  items: StatusItem[];
  uiMode: "full" | "compact";
}

export function StatusBar({ items, uiMode }: StatusBarProps) {
  const { t } = useTranslation("common");
  const isCompact = uiMode === "compact";
  const platform = useMemo(() => resolveKeybindPlatform(), []);

  // Mode badge renders the digit as a "1-3" span so the hint stays compact.
  // Pull the modifier portion (⌥ / Alt) from the MODE_OFF definition — all
  // three mode shortcuts share the same modifier by design.
  const modeDefinition = getKeybindDefinition(KEYBIND_ACTIONS.MODE_OFF, platform);
  const modeModifierBadge = modeDefinition.badge[0];
  const modeDigitsBadge = "1-3";
  const settingsDefinition = getKeybindDefinition(KEYBIND_ACTIONS.OPEN_SETTINGS, platform);

  // Derive aria labels from the shared namespace so they stay in sync with
  // the handlers wired in `useGlobalKeybinds`. The mode group hint covers
  // three distinct shortcuts (off / ambilight / solid) so we concatenate
  // them into a single accessible summary.
  const modeGroupAriaLabel = [
    t("shell.keybind.modeOff"),
    t("shell.keybind.modeAmbilight"),
    t("shell.keybind.modeSolid"),
  ].join(", ");

  return (
    <div
      className={`lm-statusbar${isCompact ? " is-compact" : ""}`}
      style={{ height: `${statusBarHeightPx(uiMode)}px` }}
      role="status"
      aria-live="polite"
    >
      {items.map((item) => (
        <StatusPill key={item.label} item={item} />
      ))}
      <div className="lm-statusbar-spacer" />
      {!isCompact && (
        <>
          <KbdHint
            keys={[modeModifierBadge, modeDigitsBadge]}
            label={t("statusBar.kbdMode")}
            ariaLabel={modeGroupAriaLabel}
          />
          <KbdHint
            keys={settingsDefinition.badge}
            label={t("statusBar.kbdSettings")}
            ariaLabel={t("shell.keybind.openSettings")}
          />
          <span className="lm-statusbar-version">v{APP_VERSION}</span>
        </>
      )}
    </div>
  );
}

function StatusPill({ item }: { item: StatusItem }) {
  return (
    <div className="lm-statusbar-pair">
      <span className="lm-statusbar-label">{item.label}</span>
      <span className={`lm-statusbar-value is-${item.kind}`}>
        <span aria-hidden>●</span> {item.state}
      </span>
    </div>
  );
}

interface KbdHintProps {
  keys: string[];
  label: string;
  ariaLabel: string;
}

function KbdHint({ keys, label, ariaLabel }: KbdHintProps) {
  return (
    <div
      className="lm-statusbar-kbd"
      role="group"
      aria-label={ariaLabel}
    >
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
      <span aria-hidden>{label}</span>
    </div>
  );
}

/**
 * Platform-aware helper for consumers (LightsSection mode strip, compact
 * mode strip) that render a single keybind badge next to a mode button.
 */
export function getKeybindBadgeForAction(action: KeybindAction): string[] {
  return getKeybindDefinition(action).badge;
}
