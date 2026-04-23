/**
 * StatusBar — fixed-bottom chrome row that sits below the content slot.
 *
 * Mirrors the title bar at the top: full width, dark amber language, always
 * visible regardless of UI mode. Shows pill indicators for the runtime
 * subsystems (CAP / USB / HUE / FPS) and — in full mode only — the keyboard
 * hint cluster and version pill on the right.
 *
 * Compact mode hides the keyboard hints + version (no room in a 320px tray
 * panel) and uses a slightly tighter font + padding, matching mockup
 * `10-compact.html`.
 *
 * Keyboard hint badges are derived from `KEYBIND_REGISTRY` so every label
 * shown here is backed by a matching handler in `useGlobalKeybinds`. Edit
 * that registry instead of hand-patching `⌥1` / `Alt+1` strings.
 *
 * The FPS pill is the runtime-performance HUD (G1). It polls
 * `get_runtime_telemetry` through `useRuntimeTelemetry` and renders a dot +
 * value whose color tracks fixed thresholds (>=45 green, 25-44 amber, <25
 * red + "Low FPS" text — text label avoids a color-only state). While
 * Ambilight is inactive the pill shows "FPS —" as a neutral placeholder.
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
import { useRuntimeTelemetry } from "../telemetry/hooks/useRuntimeTelemetry";

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

/** Fixed FPS thresholds — the user explicitly rejected a per-user preference. */
const FPS_GREEN_THRESHOLD = 45;
const FPS_AMBER_THRESHOLD = 25;

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
      <FpsPill isCompact={isCompact} />
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

/**
 * FPS / latency runtime pill (G1). Renders as the 4th StatusBar chip after
 * CAP / USB / HUE and is always mounted — an inactive Ambilight pipeline
 * shows a neutral "FPS —" placeholder rather than hiding the pill so the
 * HUD layout stays stable.
 *
 * Threshold color mapping (fixed, no user preference):
 *   >= 45 FPS → `is-ok` (green)
 *   25 — 44  → `is-active` (amber — warn but running)
 *   < 25 FPS → `is-off` repurposed via `is-low` (red) + "Low FPS" text label
 *             so the state is never expressed by color alone (a11y).
 *
 * Compact mode renders only the numeric FPS value (space budget inside the
 * 320 px tray window); full mode also tacks on the latency in `N · Xms`
 * form, fed by the shared latency unit key.
 */
interface FpsPillProps {
  isCompact: boolean;
}

function FpsPill({ isCompact }: FpsPillProps) {
  const { t } = useTranslation("common");
  const snapshot = useRuntimeTelemetry();

  const fps = snapshot.fps;
  const latencyMs = snapshot.latencyMs;
  const isActive = fps !== null;
  const fpsRounded = isActive ? Math.round(fps) : null;
  const latencyRounded = latencyMs !== null ? Math.round(latencyMs) : null;

  // Color class: map into the existing `.lm-statusbar-value.is-*` palette
  // so the CSS contract stays centralized. `is-low` is a new variant added
  // in styles.css alongside this commit.
  let kind: "idle" | "ok" | "active" | "low";
  if (!isActive) {
    kind = "idle";
  } else if (fpsRounded! >= FPS_GREEN_THRESHOLD) {
    kind = "ok";
  } else if (fpsRounded! >= FPS_AMBER_THRESHOLD) {
    kind = "active";
  } else {
    kind = "low";
  }

  const label = t("shell.fpsHud.title");

  // Numeric core — either "—" (inactive) or the rounded FPS integer.
  const fpsDisplay = isActive ? `${fpsRounded}` : "—";

  // Low-FPS text label (color-only state is an a11y violation). Rendered
  // inline only in full mode so compact stays within its tight budget.
  const lowFpsLabel = kind === "low" ? t("shell.fpsHud.lowFps") : null;

  // Full-mode latency suffix. Skipped when no latency sample is available
  // yet (first tick) or when the pipeline is inactive.
  const latencySuffix =
    !isCompact && latencyRounded !== null
      ? ` · ${latencyRounded}${t("shell.fpsHud.latencyUnit")}`
      : "";

  // Accessible label: describe both FPS and latency explicitly so screen
  // readers do not have to parse the glyph-laden visible text. Falls back
  // to the inactive string when Ambilight is off.
  const ariaLabel = isActive
    ? t("shell.fpsHud.ariaLabel", {
        fps: fpsRounded,
        latency: latencyRounded ?? 0,
      })
    : t("shell.fpsHud.inactive");

  return (
    <div className="lm-statusbar-pair" aria-label={ariaLabel}>
      <span className="lm-statusbar-label">{label}</span>
      <span className={`lm-statusbar-value is-${kind}`}>
        <span aria-hidden>●</span> {fpsDisplay}
        {lowFpsLabel ? <span className="lm-statusbar-lowfps"> {lowFpsLabel}</span> : null}
        {latencySuffix}
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
