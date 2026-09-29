import type { ReactNode } from "react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import type { LocalSink } from "@/features/device/localSink";
import { HUE_STREAM_MAX_HZ } from "@/features/hue/model/streamRate";
import { hueUnavailableReason, type HueUnavailableReason } from "@/features/hue/model/hueAvailability";
import type { HueProbeVerdict } from "@/features/hue/state/useHueBridgeReachability";
import { openLedPreview } from "@/features/preview/openLedPreview";
import { PREVIEW_OPEN_FAILURE_COPY, type PreviewOpenFailure } from "@/features/preview/previewOpenFailure";
import { RoomAwareIndicator } from "@/features/room-map/ui/RoomAwareIndicator";
import type { RoomAwareStatus } from "@/features/room-map/model/roomAware";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";
import { OUTPUT_TARGETS } from "@/shared/contracts/mode";
import { Callout } from "@/shared/ui/Callout/Callout";
import { IconButton } from "@/shared/ui/IconButton/IconButton";
import { IconPlus } from "@/shared/ui/icons";
import { Toggle } from "@/shared/ui/Toggle/Toggle";
import styles from "./OutputsRail.module.css";

const HUE_UNAVAILABLE_SUB_KEYS = {
  notConfigured: "lights:dock.rows.hueSubUnavailable",
  keyRejected: "lights:dock.rows.hueSubKeyRejected",
  unreachable: "lights:dock.rows.hueSubUnreachable",
  checking: "lights:dock.rows.hueSubChecking",
} as const satisfies Record<HueUnavailableReason, string>;

/** Why the Hue row is unavailable; only called when it is. Before boot has
 * read the saved pairing, "not paired" would be a guess, so it says checking. */
export function hueUnavailableSubKey(
  hueConfigured: boolean,
  verdict: HueProbeVerdict | null,
  bootstrapDone: boolean,
): (typeof HUE_UNAVAILABLE_SUB_KEYS)[HueUnavailableReason] {
  if (!bootstrapDone) return HUE_UNAVAILABLE_SUB_KEYS.checking;
  return HUE_UNAVAILABLE_SUB_KEYS[hueUnavailableReason(hueConfigured, false, verdict) ?? "checking"];
}

interface OutputRowView {
  available: boolean;
  /** A live stream state the row reports while selected. */
  liveState?: "reconnecting" | "failed";
  name: string;
  detail: string;
  detailLang?: string;
  sub: ReactNode;
}

export interface OutputsRailProps {
  outputTargets: HueRuntimeTarget[];
  localOutputConnected: boolean;
  localSink: LocalSink | null;
  totalLeds?: number;
  hueConfigured: boolean;
  hueReachable: boolean;
  hueProbeVerdict: HueProbeVerdict | null;
  bootstrapDone: boolean;
  hueStreaming: boolean;
  hueReconnecting: boolean;
  hueStreamFailed: boolean;
  roomAware: RoomAwareStatus | null;
  isModeTransitioning: boolean;
  onOutputTargetsChange: (targets: HueRuntimeTarget[]) => void;
  onAddOutput?: () => void;
}

/**
 * Where the light goes: one row per output, its state in a line, a switch to leave it out. The
 * last output that can light stays on. Outputs are added on Devices; the preview opens from here.
 */
export function OutputsRail({
  outputTargets,
  localOutputConnected,
  localSink,
  totalLeds,
  hueConfigured,
  hueReachable,
  hueProbeVerdict,
  bootstrapDone,
  hueStreaming,
  hueReconnecting,
  hueStreamFailed,
  roomAware,
  isModeTransitioning,
  onOutputTargetsChange,
  onAddOutput,
}: OutputsRailProps) {
  const { t } = useTranslation();
  const [previewFailure, setPreviewFailure] = useState<PreviewOpenFailure | null>(null);
  const hueAvailable = hueConfigured && hueReachable;
  const wled = localSink?.transport === "wled";

  // One row per output target: a new target fails to compile until it has one.
  const rows = {
    usb: {
      available: localOutputConnected,
      name: wled ? t("lights:dock.rows.wledName") : t("lights:dock.rows.usbName"),
      // What is actually bound: WLED's LAN address, or the USB product string the OS reported.
      // Device-supplied, so uppercased by English rules ("SERİAL" under lang="tr" otherwise).
      detail: wled ? (localSink?.id ?? "") : (localSink?.product ?? t("lights:dock.rows.usbType")),
      detailLang: wled || localSink?.product ? "en" : undefined,
      sub: localOutputConnected ? (
        <Trans
          i18nKey={wled ? "lights:dock.rows.wledSub" : "lights:dock.rows.usbSub"}
          values={{ count: totalLeds ?? 0 }}
          components={{ b: <b /> }}
        />
      ) : (
        t("lights:dock.rows.usbSubUnavailable")
      ),
    },
    hue: {
      available: hueAvailable,
      liveState: hueReconnecting ? "reconnecting" : hueStreamFailed ? "failed" : undefined,
      name: t("lights:dock.rows.hueName"),
      detail: t("lights:dock.rows.hueType"),
      sub: !hueAvailable ? (
        <Trans i18nKey={hueUnavailableSubKey(hueConfigured, hueProbeVerdict, bootstrapDone)} components={{ b: <b /> }} />
      ) : hueReconnecting ? (
        <Trans i18nKey="lights:dock.rows.hueSubReconnecting" components={{ b: <b /> }} />
      ) : hueStreamFailed ? (
        <Trans i18nKey="lights:dock.rows.hueSubFailed" components={{ b: <b /> }} />
      ) : hueStreaming ? (
        <Trans i18nKey="lights:dock.rows.hueSubStreaming" values={{ hz: HUE_STREAM_MAX_HZ }} components={{ b: <b /> }} />
      ) : (
        <Trans i18nKey="lights:dock.rows.hueSubIdle" components={{ b: <b /> }} />
      ),
    },
  } satisfies Record<HueRuntimeTarget, OutputRowView>;
  const liveSelected = outputTargets.filter((target) => rows[target].available).length;

  const toggle = (id: HueRuntimeTarget, selected: boolean) => {
    const next = selected ? outputTargets.filter((target) => target !== id) : [...outputTargets, id];
    if (next.length > 0) onOutputTargetsChange(next);
  };

  return (
    <aside className={styles.rail} aria-label={t("lights:dock.outputs")}>
      <div className={styles.head}>
        <h2 className={styles.title}>{t("lights:dock.outputs")}</h2>
        {/* Only opens Devices: it used to write an empty Hue zone at the room's origin. */}
        <IconButton
          label={t("lights:dock.addAria")}
          icon={<IconPlus />}
          onClick={onAddOutput}
          data-testid="lights-add-output"
        />
      </div>
      <ul className={styles.list}>
        {OUTPUT_TARGETS.map((target) => {
          const row: OutputRowView = rows[target];
          const selected = outputTargets.includes(target);
          // The last output that can actually receive stays on: with USB selected but unplugged,
          // turning Hue off would leave nothing lit.
          const lastLive = selected && row.available && liveSelected === 1;
          const state = !row.available ? "unavailable" : !selected ? "off" : (row.liveState ?? "on");
          return (
            <li key={target} className={styles.row} data-state={state} data-testid={`output-row-${target}`}>
              <span className={styles.dot} aria-hidden />
              <div className={styles.text}>
                <div className={styles.name}>
                  {row.name} <em lang={row.detailLang}>{row.detail}</em>
                </div>
                <div className={styles.sub}>{row.sub}</div>
              </div>
              <Toggle
                // Not locked by the calibration: dropping the strip is a way out of that lock.
                disabled={isModeTransitioning || !row.available || lastLive}
                // The saved selection is untouched; a missing output is just not shown as on.
                checked={selected && row.available}
                label={row.name}
                onChange={() => toggle(target, selected)}
                data-testid={`output-toggle-${target}`}
              />
            </li>
          );
        })}
      </ul>
      {roomAware && <RoomAwareIndicator variant="inline" status={roomAware} />}
      <div className={styles.foot}>
        <button
          type="button"
          className={styles.preview}
          onClick={() => {
            setPreviewFailure(null);
            void openLedPreview().then(setPreviewFailure, (error: unknown) => {
              console.error("[LumaSync] opening the LED preview from Lights failed:", error);
            });
          }}
          data-testid="lights-open-preview"
        >
          {t("lights:dock.preview")}
        </button>
        {previewFailure ? <Callout tone="error">{t(PREVIEW_OPEN_FAILURE_COPY[previewFailure])}</Callout> : null}
      </div>
    </aside>
  );
}
