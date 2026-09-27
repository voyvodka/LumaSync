import type { TFunction } from "i18next";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  CAPTURE_TARGET_FPS_ABSENT,
  hasSerialLinkBudget,
  type FullTelemetrySnapshot,
  type HueTelemetrySnapshot,
} from "@/shared/contracts/telemetry";
import { prefersReducedMotion } from "@/shared/lib/motion";
import { useFullTelemetryPoll } from "../hooks/useFullTelemetryPoll";
import { CaptureRateChart } from "./CaptureRateChart";
import styles from "./TelemetrySection.module.css";

const POLL_INTERVAL_MS = 2000;
/** Past the exit transition, for a window whose `transitionend` never comes. */
const CLOSE_FALLBACK_MS = 400;

type Tone = "ok" | "warn" | "crit";

interface Row {
  id: string;
  label: string;
  value: ReactNode;
  tone?: Tone;
  /** The raw code stays on hover: it is what a log search or bug report needs. */
  title?: string;
}

const QUEUE_TONE: Record<string, Tone> = { healthy: "ok", warning: "warn", critical: "crit" };
const HUE_STATE_TONE: Record<string, Tone> = { Running: "ok", Reconnecting: "warn", Failed: "crit" };

function fps(t: TFunction, value: number): string {
  return t("telemetry:fps", { fps: Math.round(value) });
}

function uptime(t: TFunction, secs: number): string {
  return secs < 60
    ? t("telemetry:uptimeSeconds", { seconds: Math.round(secs) })
    : t("telemetry:uptimeMinutes", { minutes: Math.floor(secs / 60) });
}

function lastError(t: TFunction, code: string, ageSecs: number | null): string {
  const sentence = t(`hue:runtime.codes.${code}`, { defaultValue: code });
  if (ageSecs === null) return sentence;
  // The code table is written as sentences; "gerekli. — az önce" reads as a typo.
  const message = sentence.replace(/\.$/, "");
  const minutes = Math.floor(ageSecs / 60);
  return minutes < 1
    ? t("telemetry:errorJustNow", { message })
    : t("telemetry:errorAgo", { message, minutes });
}

function hueRows(t: TFunction, hue: HueTelemetrySnapshot | null | undefined, absent: ReactNode): Row[] {
  const state = hue ? t(`hue:runtime.states.${hue.state}`, { defaultValue: hue.state }) : null;
  return [
    {
      id: "hue-stream",
      label: t("telemetry:hueStream"),
      value: !hue
        ? absent
        : hue.state === "Running" && hue.uptimeSecs !== null
          ? `${state} · ${uptime(t, hue.uptimeSecs)}`
          : state,
      tone: hue ? HUE_STATE_TONE[hue.state] : undefined,
    },
    {
      id: "hue-packets",
      label: t("telemetry:huePackets"),
      value: hue ? t("telemetry:packetRate", { rate: Math.round(hue.packetRate) }) : absent,
    },
    {
      id: "hue-error",
      label: t("telemetry:hueLastError"),
      value: !hue ? absent : hue.lastErrorCode ? lastError(t, hue.lastErrorCode, hue.lastErrorAtSecs) : t("telemetry:none"),
      tone: hue?.lastErrorCode ? "crit" : undefined,
      title: hue?.lastErrorCode ?? undefined,
    },
    {
      id: "hue-reconnects",
      label: t("telemetry:hueReconnects"),
      value: !hue
        ? absent
        : hue.failedReconnects > 0
          ? t("telemetry:reconnectsFailed", { total: hue.totalReconnects, failed: hue.failedReconnects })
          : String(hue.totalReconnects),
      tone: hue && hue.failedReconnects > 0 ? "warn" : undefined,
    },
  ];
}

function readoutRows(
  t: TFunction,
  snapshot: FullTelemetrySnapshot | null,
  { local, hue, running }: { local: boolean; hue: boolean; running: boolean },
): Row[] {
  const absent = (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{t("telemetry:unmeasured")}</span>
    </>
  );
  const usb = snapshot?.usb;
  const rows: Row[] = [
    {
      id: "capture",
      label: t("telemetry:capture"),
      value: !running
        ? t("telemetry:notRunning")
        : !usb
          ? absent
          : usb.captureTargetFps > CAPTURE_TARGET_FPS_ABSENT
            ? t("telemetry:fpsOf", { fps: Math.round(usb.captureFps), target: Math.round(usb.captureTargetFps) })
            : fps(t, usb.captureFps),
    },
  ];
  if (local) {
    rows.push(
      { id: "send", label: t("telemetry:send"), value: usb ? fps(t, usb.sendFps) : absent },
      {
        id: "queue",
        label: t("telemetry:queue"),
        value: usb ? t(`telemetry:queueHealth.${usb.queueHealth}`) : absent,
        tone: usb ? QUEUE_TONE[usb.queueHealth] : undefined,
      },
      {
        id: "link",
        label: t("telemetry:linkLimit"),
        value: usb && hasSerialLinkBudget(usb) ? fps(t, usb.linkMaxFps) : absent,
        tone: usb && hasSerialLinkBudget(usb) && usb.linkConstrained ? "warn" : undefined,
      },
    );
  }
  if (hue) rows.push(...hueRows(t, snapshot?.hue, absent));
  return rows;
}

interface TelemetrySectionProps {
  /** The "Show stats for nerds" switch. The readout stays mounted to leave the way it came. */
  open: boolean;
  localOutputConnected: boolean;
  /** The app owns a Hue session. A Hue-only setup has numbers too — the status bar showed its FPS while this stayed empty. */
  hueActive?: boolean;
}

/**
 * The readout under the "Show stats for nerds" row. Its rows are chosen from what is connected when
 * it opens, and their values wait, hidden in place, for the first reading and then appear together:
 * a loading line, then tiles, then a Hue table arriving one after another was the page changing on
 * its own as it opened. Nothing polls while it is closed; closing keeps polling until it has gone.
 */
export function TelemetrySection({ open, localOutputConnected, hueActive = false }: TelemetrySectionProps) {
  const { t } = useTranslation();
  const [closing, setClosing] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    setClosing(!open && !prefersReducedMotion());
  }

  useEffect(() => {
    if (!closing) return undefined;
    const timer = setTimeout(() => setClosing(false), CLOSE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [closing]);

  const rendered = open || closing;
  const running = localOutputConnected || hueActive;
  // Read with nothing running too: the history outlives the lights, and a gap up to now is the answer.
  const { snapshot, history, historyReadAtMs, error } = useFullTelemetryPoll(rendered, POLL_INTERVAL_MS, {
    history: true,
  });
  const failed = error !== null && snapshot === null;
  const ready = (snapshot !== null && history !== null) || failed;
  const [captureRow, ...rows] = readoutRows(t, snapshot, { local: localOutputConnected, hue: hueActive, running });
  const renderRow = (row: Row) => (
    <div key={row.id} className={styles.item} data-testid={`telemetry-${row.id}`}>
      <dt>{row.label}</dt>
      <dd className={row.tone && styles[row.tone]} title={row.title}>
        {row.value}
      </dd>
    </div>
  );

  return (
    <div
      className={styles.reveal}
      data-open={open || undefined}
      inert={!open}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !open) setClosing(false);
      }}
    >
      <div className={styles.clip}>
        {rendered && (
          <div data-testid="telemetry-readout" className={styles.readout} data-ready={ready || undefined}>
            {captureRow && <dl className={styles.list}>{renderRow(captureRow)}</dl>}
            <div className={styles.history}>
              <CaptureRateChart samples={history?.samples ?? []} endMs={historyReadAtMs ?? 0} />
            </div>
            {rows.length > 0 && <dl className={styles.list}>{rows.map(renderRow)}</dl>}
            {failed && (
              <p className={styles.error} role="alert">
                {t("telemetry:error")}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
