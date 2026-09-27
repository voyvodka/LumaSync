import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DEFAULT_LED_COLOR_ORDER,
  FIRMWARE_PROFILE,
  LED_CHIP_TYPE,
  SERIAL_DISCONNECT_STATUS,
  type LedColorOrder,
} from "@/shared/contracts/device";
import { normalizeColorOrder } from "@/shared/contracts/mode";
import type { LedStrip, StripHardware } from "@/shared/contracts/strips";
import { shellStore } from "@/features/persistence/shellStore";
import { Menu } from "@/shared/ui/Menu/Menu";
import { PageSwap } from "@/shared/ui/PageSwap/PageSwap";
import { Reveal } from "@/shared/ui/Reveal/Reveal";
import { RowButton, RowNote, SettingRow } from "@/shared/ui/SettingRow/SettingRow";
import { StateSwap } from "@/shared/ui/StateSwap/StateSwap";
import { StateWord } from "@/shared/ui/StateWord/StateWord";

import { disconnectSerialPort } from "../deviceConnectionApi";
import { buildDeviceStatusCard } from "../deviceStatusCard";
import { shortPortName } from "../model/deviceRail";
import { serialEntry } from "../model/localOutputs";
import { STRIP_STATE_VIEW, serialStripState } from "../model/stripState";
import { useLocalOutputs } from "../state/localOutputsStore";
import { useStripUnlit, type FlashOutcome } from "../state/stripFlash";
import { useAdvertisedFirmwareProfile, useAdvertisedPixelLayout } from "../useAdvertisedFirmwareProfile";
import type { UseDeviceConnectionResult } from "../useDeviceConnection";
import { ChipRow, ColorOrderRow, FirmwareRow, saveHardware } from "./StripHardwareRows";
import { StripFlash } from "./StripFlash";
import { StripName } from "./StripName";
import styles from "./StripPage.module.css";

export interface StripPageProps {
  isActive: boolean;
  /** A strip on a serial port. */
  strip: LedStrip & { transport: { kind: "serial"; portName: string } };
  /** The name as shown: the user's, or the device's. */
  name: string;
  device: UseDeviceConnectionResult;
  onNavigateToLedSetup?: () => void;
  onNavigateToRoomMap?: () => void;
}

/** Edges a layout lights, for the Layout row's value. */
function edgesOf(strip: LedStrip): number {
  const counts = strip.layout?.counts;
  return counts ? Object.values(counts).filter((count) => count > 0).length : 0;
}

/**
 * A USB strip's page: its state in a word and the one thing to do about it, its layout, the
 * hardware it is built from, and a health check. Daily controls — on, off, brightness — are on
 * Lights; this page sets the strip up.
 */
export function StripPage({ isActive, strip, name, device, onNavigateToLedSetup, onNavigateToRoomMap }: StripPageProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const port = strip.transport.portName;
  const firmwareRowRef = useRef<HTMLDivElement | null>(null);

  const entry = useLocalOutputs(({ snapshot }) => serialEntry(snapshot, port));
  const unlit = useStripUnlit(strip.id);
  const advertised = useAdvertisedFirmwareProfile();
  const advertisedLayout = useAdvertisedPixelLayout();
  const profile = strip.hardware.firmwareProfile ?? FIRMWARE_PROFILE.LUMASYNC_V1;
  const chip = strip.hardware.chipType ?? LED_CHIP_TYPE.WS2812B_GRB;
  const order: LedColorOrder = normalizeColorOrder(strip.hardware.colorOrder) ?? DEFAULT_LED_COLOR_ORDER;

  const product = device.ports.find((candidate) => candidate.portName === port)?.product ?? null;
  const connecting = device.isConnecting && device.selectedPort === port;
  const connected = entry?.connected === true;
  const state = serialStripState({
    connecting,
    entry,
    unlit,
    firmwareMismatch: connected && advertised !== undefined && advertised !== profile,
  });
  const view = STRIP_STATE_VIEW[state];

  const [flashProblem, setFlashProblem] = useState<Exclude<FlashOutcome, "lit"> | null>(null);
  const [disconnectFailed, setDisconnectFailed] = useState(false);
  const [hardwareFailed, setHardwareFailed] = useState(false);
  const saveOrSay = (patch: Partial<StripHardware>) => {
    setHardwareFailed(false);
    saveHardware(strip.id, patch).catch(() => setHardwareFailed(true));
  };
  const [dontAsk, setDontAsk] = useState(false);
  useEffect(() => {
    let cancelled = false;
    shellStore
      .load()
      .then((stored) => {
        if (!cancelled) setDontAsk(stored.dontWarnFirmwareProfileMismatch === true);
      })
      .catch((error: unknown) => {
        console.error("[LumaSync] reading the firmware warning preference failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = () => {
    setDisconnectFailed(false);
    device.selectPort(port);
    void device.connectSelectedPort();
  };
  const disconnect = async () => {
    setDisconnectFailed(false);
    const result = await disconnectSerialPort(port);
    if (result.status.code === SERIAL_DISCONNECT_STATUS.FAILED) setDisconnectFailed(true);
  };

  // The next thing to do is the page's one amber: connecting a strip that is not, then its layout.
  const needsLayout = strip.layout === undefined;
  const actionPrimary = view.action === "connect" || view.action === "retry";
  const action =
    view.action === "flash" || (view.action === "retry" && state === "unlit") ? (
      <StripFlash
        stripId={strip.id}
        layout={strip.layout}
        label={state === "unlit" ? "retry" : "flash"}
        primary={state === "unlit"}
        onProblem={setFlashProblem}
      />
    ) : view.action === "connect" || view.action === "retry" ? (
      <RowButton primary={actionPrimary} onClick={connect} data-testid="strip-connect">
        {t(view.action === "retry" ? "device:strip.action.retry" : "device:strip.action.connect")}
      </RowButton>
    ) : view.action === "settings" ? (
      <RowButton
        onClick={() => firmwareRowRef.current?.querySelector<HTMLElement>("[aria-checked='true']")?.focus()}
        data-testid="strip-settings"
      >
        {t("device:strip.action.settings")}
      </RowButton>
    ) : null;

  // A failed connect of this port, in the user's language, with Rust's detail kept verbatim.
  const card = buildDeviceStatusCard({
    status: device.status,
    statusCard: device.statusCard,
    connectedPort: connected ? port : null,
  });
  const connectError =
    device.statusCard?.variant === "error" && device.selectedPort === port && !connected ? card : null;

  const health = device.latestHealthCheck;
  const failedStep = health
    ? buildDeviceStatusCard({ status: device.status, statusCard: null, connectedPort: port, latestHealthCheck: health })
        .healthSteps?.find((step) => !step.pass)
    : undefined;
  const healthValue =
    health === null
      ? t("device:strip.health.never")
      : health.pass
        ? t("device:strip.health.passed", {
            time: new Date(health.checkedAtUnixMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          })
        : failedStep?.text
          ? t(failedStep.text.labelKey)
          : t("device:healthCheck.failTitle");
  const healthFailed = health !== null && !health.pass && !device.isHealthChecking;

  const menuItems = [
    ...(connected
      ? [{ id: "disconnect", label: t("device:strip.action.disconnect"), onSelect: () => void disconnect() }]
      : []),
    ...(onNavigateToRoomMap ? [{ id: "map", label: t("device:strip.action.openInMap"), onSelect: onNavigateToRoomMap }] : []),
  ];

  return (
    <section className={styles.page} hidden={!isActive} aria-labelledby={headingId} data-testid="strip-page">
      <StripName stripId={strip.id} name={name} renamed={strip.name !== undefined} headingId={headingId} />
      <div className={styles.rows}>
        <Reveal open>
          <SettingRow
            label={t("device:strip.row.controller")}
            value={product ? `${product} · ${shortPortName(port)}` : shortPortName(port)}
            testId="strip-controller"
            controlFills
            control={
              <PageSwap id={state} way="fade" className={styles.swap}>
                <StateWord tone={view.tone} live={false}>
                  {t(view.word)}
                </StateWord>
                {action}
                <Menu label={t("device:strip.action.more", { name })} items={menuItems} testId="strip-more" />
              </PageSwap>
            }
          >
            <span className="sr-only" role="status" aria-live="polite" data-testid="strip-state">
              {t(view.word)}
            </span>
            <Reveal open={connectError !== null}>
              {connectError ? (
                <RowNote tone="error" testId="strip-connect-error">
                  {t(connectError.titleKey)}. {t(connectError.bodyKey)}
                  {connectError.detailsKey ? ` ${t(connectError.detailsKey)}` : null}
                  {connectError.details ? <span className={styles.detail}> {connectError.details}</span> : null}
                </RowNote>
              ) : null}
            </Reveal>
            <Reveal open={flashProblem !== null}>
              {flashProblem ? (
                <RowNote tone="error" testId="strip-flash-problem">
                  {t(flashProblem === "notSent" ? "device:strip.flash.notSent" : "device:strip.flash.failed")}
                </RowNote>
              ) : null}
            </Reveal>
            <Reveal open={disconnectFailed}>
              {disconnectFailed ? <RowNote tone="error">{t("device:strip.disconnectFailed")}</RowNote> : null}
            </Reveal>
            <Reveal open={state === "unlit"}>
              <div className={styles.help} data-testid="strip-unlit-help">
                <p>{t("device:strip.flash.help.title")}</p>
                <ol>
                  <li>{t("device:strip.flash.help.ground")}</li>
                  <li>{t("device:strip.flash.help.data")}</li>
                  <li>{t("device:strip.flash.help.firmware")}</li>
                </ol>
              </div>
            </Reveal>
          </SettingRow>
        </Reveal>

        <Reveal open>
          <SettingRow
            label={t("device:strip.row.layout")}
            value={
              needsLayout
                ? t("device:strip.layoutNone")
                : t("device:strip.layoutValue", { count: strip.layout?.totalLeds ?? 0, edges: edgesOf(strip) })
            }
            testId="strip-layout"
            control={
              onNavigateToLedSetup ? (
                <RowButton primary={needsLayout && !actionPrimary} onClick={onNavigateToLedSetup} data-testid="strip-layout-open">
                  {t(needsLayout ? "device:strip.action.setUp" : "device:strip.action.edit")} ›
                </RowButton>
              ) : null
            }
          />
        </Reveal>

        <Reveal open>
          <div ref={firmwareRowRef}>
            <FirmwareRow
              profile={profile}
              advertised={advertised}
              dontAsk={dontAsk}
              onChange={(next) => saveOrSay({ firmwareProfile: next })}
            />
          </div>
        </Reveal>
        <Reveal open>
          <ChipRow
            chip={chip}
            profile={profile}
            advertisedLayout={advertisedLayout}
            onChange={(next) => saveOrSay({ chipType: next })}
          />
        </Reveal>
        <Reveal open={hardwareFailed}>
          {hardwareFailed ? (
            <RowNote tone="error" testId="strip-hardware-failed">
              {t("device:strip.hardwareFailed")}
            </RowNote>
          ) : null}
        </Reveal>
        <Reveal open>
          <ColorOrderRow stripId={strip.id} order={order} canIdentify={connected} />
        </Reveal>

        <Reveal open>
          <SettingRow
            label={t("device:strip.row.health")}
            hint={t("device:strip.hint.health")}
            value={<span data-testid="strip-health-value">{healthValue}</span>}
            testId="strip-health"
            control={
              <RowButton
                disabled={!connected || device.isHealthChecking}
                aria-busy={device.isHealthChecking || undefined}
                onClick={() => {
                  device.selectPort(port);
                  void device.runHealthCheck();
                }}
                data-testid="strip-health-run"
              >
                <StateSwap
                  fit
                  state={device.isHealthChecking ? "busy" : health === null ? "idle" : "again"}
                  faces={{
                    idle: t("device:strip.action.check"),
                    again: t("device:strip.action.checkAgain"),
                    busy: t("device:strip.action.checking"),
                  }}
                />
              </RowButton>
            }
          >
            <Reveal open={healthFailed}>
              {healthFailed ? (
                <RowNote tone="error" testId="strip-health-failed">
                  {failedStep?.text ? t(failedStep.text.hintKey) : (failedStep?.message ?? t("device:healthCheck.failBody"))}
                  {failedStep?.text?.details ? <span className={styles.detail}> {failedStep.text.details}</span> : null}
                </RowNote>
              ) : null}
            </Reveal>
          </SettingRow>
        </Reveal>
      </div>
    </section>
  );
}
