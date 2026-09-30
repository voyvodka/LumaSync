/**
 * StatusBar — the fixed bottom row: each output in a word beside a dot, and with stats for nerds on,
 * capture and the frame rate. A chip about something to deal with is a button: pressed, it says
 * what in one sentence beside it and offers the page where it is dealt with, instead of taking the
 * window there. Keyboard shortcuts live in Settings → Help and the version in About.
 *
 * Deliberately not a live region: the FPS pill ticks at 1 Hz, and what needs saying about a chip
 * going down is said by the notice queue.
 */

import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Popover } from "@/shared/ui/Popover/Popover";
import { useRuntimeTelemetry, type PipelineHealth } from "../telemetry/hooks/useRuntimeTelemetry";
import { usePreference } from "../persistence/preferences";
import styles from "./StatusBar.module.css";

export const STATUS_BAR_HEIGHT_FULL_PX = 24;
export const STATUS_BAR_HEIGHT_COMPACT_PX = 22;

export function statusBarHeightPx(uiMode: "full" | "compact"): number {
  return uiMode === "compact" ? STATUS_BAR_HEIGHT_COMPACT_PX : STATUS_BAR_HEIGHT_FULL_PX;
}

export type StatusKind = "ok" | "active" | "idle" | "off" | "error";

export interface StatusAttention {
  /** What is wrong, or not set up yet, in one sentence. */
  hint: string;
  /** Where it is dealt with, e.g. "Devices". */
  action: string;
  onAction: () => void;
}

export interface StatusItem {
  /** Names the chip in its test id; the label is translated, so it cannot. */
  id: "cap" | "usb" | "wled" | "hue";
  /** Short name, e.g. "USB", "Hue". */
  label: string;
  /** One word, e.g. "Ready", "Streaming". */
  state: string;
  /** Drives the dot and the word's colour. */
  kind: StatusKind;
  /** Something to deal with: the chip opens it. Ignored on an `ok` chip. */
  attention?: StatusAttention;
  /** Shown only with "Show stats for nerds" on. */
  nerdStat?: boolean;
}

interface StatusBarProps {
  items: StatusItem[];
  uiMode: "full" | "compact";
  /**
   * Whether lighting is on. With it off the FPS pill holds its placeholder and polls nothing.
   * Defaults to `true` for consumers that have not wired the signal.
   */
  lightingActive?: boolean;
  /** Something to act on at the end of the row: an update that is ready. Owns its own subscription. */
  trailing?: ReactNode;
}

export function StatusBar({ items, uiMode, lightingActive = true, trailing }: StatusBarProps) {
  const isCompact = uiMode === "compact";
  const showNerdStats = usePreference("showNerdStats");
  const shownItems = showNerdStats ? items : items.filter((item) => item.nerdStat !== true);

  return (
    <div
      className={isCompact ? `${styles.bar} ${styles.compact}` : styles.bar}
      style={{ height: `${statusBarHeightPx(uiMode)}px` }}
      data-testid="status-bar"
      data-nerd-stats={showNerdStats ? "on" : "off"}
    >
      {shownItems.map((item) => (
        <StatusChip key={item.label} item={item} />
      ))}
      {showNerdStats && <FpsPill isCompact={isCompact} enabled={lightingActive} />}
      <div className={styles.spacer} />
      {trailing}
    </div>
  );
}

function StatusChip({ item }: { item: StatusItem }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const testId = `status-chip-${item.id.toUpperCase()}`;
  // A new word ticks in; the one the window opens on stays put. Only a span mounted for a new word
  // carries the flag, so no existing span starts an animation when it is set.
  const word = useRef({ state: item.state, changed: false });
  if (word.current.state !== item.state) word.current = { state: item.state, changed: true };
  const face = (
    <>
      <span aria-hidden className={`${styles.dot} ${styles[item.kind]}`} />
      <span className={styles.label}>{item.label}</span>
      <span
        key={item.state}
        className={`${styles.value} ${styles[item.kind]}`}
        data-kind={item.kind}
        data-changed={word.current.changed || undefined}
      >
        {item.state}
      </span>
    </>
  );
  // A healthy chip opens nothing: that would say something is wrong when nothing is.
  const attention = item.kind === "ok" ? undefined : item.attention;
  if (!attention) {
    return (
      <div className={styles.chip} data-testid={testId}>
        {face}
      </div>
    );
  }
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`${styles.chip} ${styles.button}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((was) => !was)}
        data-testid={testId}
      >
        {face}
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        side="above"
        width={220}
        label={`${item.label} ${item.state}`}
        role="dialog"
      >
        <div className={styles.attention}>
          <p>{attention.hint}</p>
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              setOpen(false);
              attention.onAction();
            }}
          >
            {attention.action} ›
          </button>
        </div>
      </Popover>
    </>
  );
}

/**
 * FPS / latency runtime pill. Renders as the 4th StatusBar chip after
 * CAP / USB / HUE, mounted whenever stats for nerds is on — an inactive
 * Ambilight pipeline shows a neutral "FPS —" placeholder rather than hiding
 * the pill so the HUD layout stays stable.
 *
 * The colour says whether the output keeps up, not how high the number is: capture counts distinct
 * frames and aims at 20–30 fps, so fixed 45/25 thresholds read a Hue session, or a still screen,
 * as failing. `ok` is green, `strained` amber, `behind` red
 * plus the "Low FPS" words, so the state is never expressed by colour alone (a11y).
 *
 * Compact mode renders only the numeric FPS value (space budget inside the
 * 320 px tray window); full mode also tacks on the latency in `N · Xms`
 * form, fed by the shared latency unit key.
 */
const FPS_KIND = { ok: "ok", strained: "active", behind: "low" } as const satisfies Record<PipelineHealth, string>;

interface FpsPillProps {
  isCompact: boolean;
  /**
   * `false` when lighting is OFF — the underlying hook then suspends its
   * 1 Hz poll and the pill renders the inactive `—` placeholder. As soon
   * as the user flips into Ambilight or Solid this becomes `true` and
   * the hook re-arms with an immediate first tick.
   */
  enabled: boolean;
}

function FpsPill({ isCompact, enabled }: FpsPillProps) {
  const { t } = useTranslation();
  const snapshot = useRuntimeTelemetry(undefined, enabled);

  const fps = snapshot.fps;
  const latencyMs = snapshot.latencyMs;
  const isActive = fps !== null;
  const fpsRounded = isActive ? Math.round(fps) : null;
  const latencyRounded = latencyMs !== null ? Math.round(latencyMs) : null;

  const kind = !isActive || snapshot.health === null ? "idle" : FPS_KIND[snapshot.health];

  const label = t("shell:fpsHud.title");

  // Numeric core — either "—" (inactive) or the rounded FPS integer.
  const fpsDisplay = isActive ? `${fpsRounded}` : "—";

  // Low-FPS text label (color-only state is an a11y violation). Rendered
  // inline only in full mode so compact stays within its tight budget.
  const lowFpsLabel = kind === "low" ? t("shell:fpsHud.lowFps") : null;

  // Full-mode latency suffix, skipped until the first sample lands. The "·"
  // rides inside the string so the suffix fits one reserved-width box.
  const latencySuffix =
    !isCompact && latencyRounded !== null
      ? `· ${latencyRounded}${t("shell:fpsHud.latencyUnit")}`
      : "";

  // Accessible label: describe both FPS and latency explicitly so screen
  // readers do not have to parse the glyph-laden visible text. Falls back
  // to the inactive string when Ambilight is off.
  const ariaLabel = isActive
    ? t("shell:fpsHud.ariaLabel", {
        fps: fpsRounded,
        latency: latencyRounded ?? 0,
      })
    : t("shell:fpsHud.inactive");

  return (
    <div className={styles.chip} aria-label={ariaLabel} data-testid="status-fps">
      <span aria-hidden className={`${styles.dot} ${styles[kind]}`} />
      <span className={styles.label}>{label}</span>
      <span className={`${styles.value} ${styles[kind]}`} data-kind={kind}>
        <span className={styles.fps} data-testid="status-fps-value">
          {fpsDisplay}
        </span>
        {lowFpsLabel ? <span className={styles.lowFps}>{lowFpsLabel}</span> : null}
        {latencySuffix ? <span className={styles.latency}>{latencySuffix}</span> : null}
      </span>
    </div>
  );
}
