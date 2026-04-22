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
 */

import { useTranslation } from "react-i18next";

import { APP_VERSION } from "../../shared/constants/app";

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
          <KbdHint keys={["⌥", "1-3"]} label={t("statusBar.kbdMode")} />
          <KbdHint keys={["⌘", ","]} label={t("statusBar.kbdSettings")} />
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

function KbdHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="lm-statusbar-kbd">
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
      <span>{label}</span>
    </div>
  );
}
