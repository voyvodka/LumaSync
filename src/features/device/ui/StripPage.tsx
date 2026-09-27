import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DEFAULT_LED_COLOR_ORDER,
  FIRMWARE_PROFILE,
  LED_CHIP_TYPE,
  SERIAL_CONNECT_STATUS,
  SERIAL_DISCONNECT_STATUS,
  SERIAL_OUTPUT_STATUS,
  type LedColorOrder,
} from "@/shared/contracts/device";
import { normalizeColorOrder } from "@/shared/contracts/mode";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import type { LedStrip, StripHardware } from "@/shared/contracts/strips";
import { shellStore } from "@/features/persistence/shellStore";
import { withoutStrip } from "@/features/strips/model/stripWrites";
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
import { addToRoomMap, connectAsUser, useRosterFailed } from "../state/connectAsUser";
import { useLocalOutputs } from "../state/localOutputsStore";
import { useStripUnlit, type FlashOutcome } from "../state/stripFlash";
import { useAdvertisedFirmwareProfile, useAdvertisedPixelLayout } from "../useAdvertisedFirmwareProfile";
import type { UseDeviceConnectionResult } from "../useDeviceConnection";
import { ChipRow, ColorOrderRow, FirmwareRow, saveHardware } from "./StripHardwareRows";
import { StripFlash } from "./StripFlash";
import { StripLayoutRow } from "./StripLayoutRow";
import { StripName } from "./StripName";
import { CodedNote, UnlitHelp, connectFailedOn } from "./StripNotes";
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
  /** The strip was just added: flash it and ask as soon as it is connected. */
  autoFlash?: boolean;
  onAutoFlashDone?: () => void;
}

/**
 * A USB strip's page: its state in a word and the one thing to do about it, its layout, the
 * hardware it is built from, and a health check. Daily controls — on, off, brightness — are on
 * Lights; this page sets the strip up.
 */
export function StripPage({
  isActive,
  strip,
  name,
  device,
  onNavigateToLedSetup,
  onNavigateToRoomMap,
  autoFlash = false,
  onAutoFlashDone,
}: StripPageProps) {
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

  const plugged = device.ports.find((candidate) => candidate.portName === port);
  const product = plugged?.product ?? null;
  const usbId =
    plugged?.vid !== undefined && plugged.pid !== undefined
      ? `${plugged.vid.toString(16).padStart(4, "0")}:${plugged.pid.toString(16).padStart(4, "0")}`.toUpperCase()
      : null;
  // Only what the row does not show already: with nothing enumerated there is nothing to add.
  const controllerHint =
    plugged?.manufacturer || usbId
      ? [plugged?.manufacturer, usbId && `USB ${usbId}`, port].filter(Boolean).join(" · ")
      : undefined;
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
  // Whether the room map has a placement on this port; `null` until the store answers.
  const [placed, setPlaced] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    const placedOn = (roomMap: RoomMapConfig | null | undefined) =>
      roomMap?.usbStrips.some((placement) => placement.portName === port) ?? false;
    shellStore
      .load()
      .then((stored) => {
        if (cancelled) return;
        setDontAsk(stored.dontWarnFirmwareProfileMismatch === true);
        setPlaced(placedOn(stored.roomMap));
      })
      .catch((error: unknown) => {
        console.error("[LumaSync] reading the strip's settings failed:", error);
      });
    const stop = shellStore.onSaved((saved) => {
      if ("roomMap" in saved) setPlaced(placedOn(saved.roomMap));
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [port]);

  const connect = () => {
    setDisconnectFailed(false);
    void connectAsUser(device, port);
  };
  const rosterFailed = useRosterFailed(port);
  const disconnect = async (): Promise<boolean> => {
    setDisconnectFailed(false);
    const result = await disconnectSerialPort(port);
    if (result.status.code !== SERIAL_DISCONNECT_STATUS.FAILED) return true;
    setDisconnectFailed(true);
    return false;
  };
  const [forgetFailed, setForgetFailed] = useState(false);
  // Let go of first: a strip still driving must not lose its record. A refusal forgets nothing.
  const forget = async () => {
    setForgetFailed(false);
    if (connected && !(await disconnect())) return;
    try {
      await shellStore.update((state) => withoutStrip(state, strip.id));
    } catch (error) {
      console.error("[LumaSync] forgetting the strip failed:", error);
      setForgetFailed(true);
    }
  };

  // The next thing to do is the page's one amber: connecting a strip that is not, then its layout.
  const actionPrimary = view.action === "connect" || view.action === "retry";
  const action =
    view.action === "flash" || (view.action === "retry" && state === "unlit") ? (
      <StripFlash
        stripId={strip.id}
        layout={strip.layout}
        label={state === "unlit" ? "retry" : "flash"}
        primary={state === "unlit"}
        onProblem={setFlashProblem}
        auto={autoFlash}
        onAutoDone={onAutoFlashDone}
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

  // Why it is not lighting: the user's own failed connect first, else what Rust recorded for the port.
  // A port let go of (DISCONNECTED) is not a failure.
  const entryFailed =
    entry !== null &&
    !entry.connected &&
    entry.status.code !== SERIAL_OUTPUT_STATUS.DISCONNECTED &&
    entry.status.code !== SERIAL_CONNECT_STATUS.OK;
  const userFailed = !connected && connectFailedOn(device, port);
  const failure = connecting ? null : userFailed ? device.statusCard : entryFailed ? entry.status : null;

  // The controller keeps one result for whichever port was checked; this page shows it only for the
  // port it checked, so a strip moved to another controller does not show the old one's pass.
  const [checkedPort, setCheckedPort] = useState<string | null>(null);
  const health = checkedPort === port ? device.latestHealthCheck : null;
  const checking = device.isHealthChecking && checkedPort === port;
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
  const healthFailed = health !== null && !health.pass && !checking;

  const menuItems = [
    ...(connected
      ? [{ id: "disconnect", label: t("device:strip.action.disconnect"), onSelect: () => void disconnect() }]
      : []),
    // A launch reconnect writes no placement; this is the way to one without reconnecting.
    ...(connected && placed === false
      ? [{ id: "place", label: t("device:strip.action.addToMap"), onSelect: () => void addToRoomMap(port) }]
      : []),
    ...(onNavigateToRoomMap ? [{ id: "map", label: t("device:strip.action.openInMap"), onSelect: onNavigateToRoomMap }] : []),
    {
      id: "forget",
      label: t("device:strip.action.forget"),
      danger: true,
      onSelect: () => void forget(),
      confirm: {
        text: t("device:strip.forgetConfirm", { name }),
        confirmLabel: t("device:strip.action.forget"),
        cancelLabel: t("device:strip.firmware.cancel"),
        testId: "strip-forget-confirm",
        confirmTestId: "strip-forget-confirm-yes",
      },
    },
  ];

  return (
    <section className={styles.page} hidden={!isActive} aria-labelledby={headingId} data-testid="strip-page">
      <StripName stripId={strip.id} name={name} renamed={strip.name !== undefined} headingId={headingId} />
      <div className={styles.rows}>
        <Reveal open>
          <SettingRow
            label={t("device:strip.row.controller")}
            value={product ? `${product} · ${shortPortName(port)}` : shortPortName(port)}
            hint={controllerHint}
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
            <Reveal open={failure !== null}>
              {failure ? (
                <CodedNote
                  failure={{ code: failure.code, message: failure.message, details: failure.details }}
                  testId="strip-connect-error"
                />
              ) : null}
            </Reveal>
            <Reveal open={flashProblem !== null}>
              {flashProblem ? (
                <RowNote tone="error" testId="strip-flash-problem">
                  {t(flashProblem === "notSent" ? "device:strip.flash.notSent" : "device:strip.flash.failed")}
                </RowNote>
              ) : null}
            </Reveal>
            <Reveal open={rosterFailed}>
              {rosterFailed ? (
                <RowNote tone="error" testId="strip-roster-failed">
                  {t("device:strip.roomMapFailed")}
                </RowNote>
              ) : null}
            </Reveal>
            <Reveal open={forgetFailed}>
              {forgetFailed ? (
                <RowNote tone="error" testId="strip-forget-failed">
                  {t("device:strip.forgetFailed")}
                </RowNote>
              ) : null}
            </Reveal>
            <Reveal open={disconnectFailed}>
              {disconnectFailed ? <RowNote tone="error">{t("device:strip.disconnectFailed")}</RowNote> : null}
            </Reveal>
            <Reveal open={state === "unlit"}>
              <UnlitHelp />
            </Reveal>
          </SettingRow>
        </Reveal>

        <Reveal open>
          <StripLayoutRow strip={strip} primary={!actionPrimary} onOpen={onNavigateToLedSetup} />
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
              // Nothing to check without a connection: the row keeps its value, not a dead button.
              !connected ? null : (
              <RowButton
                disabled={device.isHealthChecking}
                aria-busy={checking || undefined}
                onClick={() => {
                  setCheckedPort(port);
                  device.selectPort(port);
                  void device.runHealthCheck();
                }}
                data-testid="strip-health-run"
              >
                <StateSwap
                  fit
                  state={checking ? "busy" : health === null ? "idle" : "again"}
                  faces={{
                    idle: t("device:strip.action.check"),
                    again: t("device:strip.action.checkAgain"),
                    busy: t("device:strip.action.checking"),
                  }}
                />
              </RowButton>
              )
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
