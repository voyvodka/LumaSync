import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { WLED_STATUS, type WledCommandStatus, type WledDeviceInfo } from "@/shared/contracts/device";
import type { LedStrip, StripTransport } from "@/shared/contracts/strips";
import { Menu } from "@/shared/ui/Menu/Menu";
import { PageSwap } from "@/shared/ui/PageSwap/PageSwap";
import { Reveal } from "@/shared/ui/Reveal/Reveal";
import { RowButton, RowNote, SettingRow } from "@/shared/ui/SettingRow/SettingRow";
import { StateSwap } from "@/shared/ui/StateSwap/StateSwap";
import { StateWord } from "@/shared/ui/StateWord/StateWord";

import { STRIP_STATE_VIEW, wledStripState } from "../model/stripState";
import { wledStatusKey } from "../model/wledStatus";
import { useStripUnlit, type FlashOutcome } from "../state/stripFlash";
import { useWledConnect, type WledConnectDeps } from "../state/useWledConnect";
import type { ActiveWledSink } from "../useWledSink";
import { testWledBridge } from "../wledApi";
import { StripFlash } from "./StripFlash";
import { StripLayoutRow } from "./StripLayoutRow";
import { StripName } from "./StripName";
import { UnlitHelp } from "./StripNotes";
import styles from "./StripPage.module.css";

type WledTransport = Extract<StripTransport, { kind: "wled" }>;

export interface WledStripPageProps {
  isActive: boolean;
  strip: LedStrip & { transport: WledTransport };
  name: string;
  wled: Pick<ActiveWledSink, "activeWledIp" | "restoreOutcome" | "markConnected" | "forget">;
  onNavigateToLedSetup?: () => void;
  onNavigateToRoomMap?: () => void;
  autoFlash?: boolean;
  onAutoFlashDone?: () => void;
  connectDeps?: WledConnectDeps;
  checkBridge?: typeof testWledBridge;
}

/**
 * A WLED strip's page: its state in a word and the one thing to do about it, the LED count the
 * device reports, and its layout. WLED owns its chip and colour order, so there are no hardware rows.
 */
export function WledStripPage({
  isActive,
  strip,
  name,
  wled,
  onNavigateToLedSetup,
  onNavigateToRoomMap,
  autoFlash = false,
  onAutoFlashDone,
  connectDeps,
  checkBridge = testWledBridge,
}: WledStripPageProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const { ip, ledCount } = strip.transport.sink;
  const connector = useWledConnect(connectDeps);
  const unlit = useStripUnlit(strip.id);
  const restore = wled.restoreOutcome;
  const restoring = restore.kind === "restoring" && restore.sink.ip === ip;
  const bound = wled.activeWledIp === ip;
  const state = wledStripState({ connecting: connector.connecting === ip || restoring, bound, unlit });
  const view = STRIP_STATE_VIEW[state];

  const [failure, setFailure] = useState<WledCommandStatus | null>(null);
  const [flashProblem, setFlashProblem] = useState<Exclude<FlashOutcome, "lit"> | null>(null);
  const [forgetFailed, setForgetFailed] = useState<WledCommandStatus | null>(null);
  // A failed launch reconnect is said once, until this page tries again.
  const restoreFailed = restore.kind === "failed" && restore.sink.ip === ip && !bound && failure === null;
  const shownFailure = failure ?? (restoreFailed && restore.kind === "failed" ? restore.status : null);
  const failureKey = shownFailure ? wledStatusKey(shownFailure.code) : null;

  const [check, setCheck] = useState<{ status: WledCommandStatus; at: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const runCheck = async () => {
    const device: WledDeviceInfo = { ip, ledCount };
    setChecking(true);
    try {
      setCheck({ status: (await checkBridge(device)).status, at: Date.now() });
    } catch (error) {
      console.error("[LumaSync] checking the WLED device failed:", error);
      setCheck({ status: { code: WLED_STATUS.TEST_WORKER_FAILED, message: String(error), details: null }, at: Date.now() });
    } finally {
      setChecking(false);
    }
  };
  const checkPassed = check?.status.code === WLED_STATUS.TEST_LIVE_CONFIRMED;
  const checkKey = check ? wledStatusKey(check.status.code) : null;

  const connect = async () => {
    setFailure(null);
    const status = await connector.connect(ip, wled.markConnected);
    if (status.code !== WLED_STATUS.CONNECT_OK) setFailure(status);
  };

  const forget = async () => {
    setForgetFailed(null);
    const status = await wled.forget(ip);
    if (status.code !== WLED_STATUS.FORGET_OK) setForgetFailed(status);
  };

  const connectPrimary = view.action === "connect";
  const action =
    view.action === "flash" || state === "unlit" ? (
      <StripFlash
        stripId={strip.id}
        layout={strip.layout}
        label={state === "unlit" ? "retry" : "flash"}
        primary={state === "unlit"}
        onProblem={setFlashProblem}
        auto={autoFlash}
        onAutoDone={onAutoFlashDone}
      />
    ) : view.action === "connect" ? (
      <RowButton primary onClick={() => void connect()} data-testid="strip-connect">
        {t("device:strip.action.connect")}
      </RowButton>
    ) : null;

  const menuItems = [
    {
      id: "forget",
      label: t("device:strip.action.forget"),
      danger: true,
      onSelect: () => void forget(),
      confirm: {
        text: t("device:page.wled.forgetConfirm.body", { ip }),
        confirmLabel: t("device:page.wled.forgetConfirm.confirm"),
        cancelLabel: t("device:page.wled.forgetConfirm.cancel"),
        testId: "wled-forget-confirm",
        confirmTestId: "wled-forget-confirm-yes",
      },
    },
    ...(onNavigateToRoomMap ? [{ id: "map", label: t("device:strip.action.openInMap"), onSelect: onNavigateToRoomMap }] : []),
  ];

  return (
    <section className={styles.page} hidden={!isActive} aria-labelledby={headingId} data-testid="wled-strip-page">
      <StripName stripId={strip.id} name={name} renamed={strip.name !== undefined} headingId={headingId} />
      <div className={styles.rows}>
        <Reveal open>
          <SettingRow
            label={t("device:strip.row.device")}
            value={ip}
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
            <Reveal open={shownFailure !== null}>
              {shownFailure ? (
                <RowNote tone="error" testId="wled-connect-failed">
                  {restoreFailed ? `${t("device:page.wled.restore.failed", { ip })} ` : null}
                  {failureKey ? t(failureKey) : shownFailure.message}
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
            <Reveal open={forgetFailed !== null}>
              {forgetFailed ? (
                <RowNote tone="error" testId="wled-forget-failed">
                  {t("device:page.wled.status.forgetFailed")}
                </RowNote>
              ) : null}
            </Reveal>
            <Reveal open={state === "unlit"}>
              <UnlitHelp />
            </Reveal>
          </SettingRow>
        </Reveal>

        <Reveal open>
          <SettingRow
            label={t("device:strip.row.ledCount")}
            value={t("device:strip.ledCountValue", { count: ledCount })}
            testId="strip-led-count"
          />
        </Reveal>

        <Reveal open>
          <StripLayoutRow strip={strip} primary={!connectPrimary && state !== "unlit"} onOpen={onNavigateToLedSetup} />
        </Reveal>

        <Reveal open>
          <SettingRow
            label={t("device:strip.row.health")}
            hint={t("device:strip.hint.wledHealth")}
            value={
              <span data-testid="strip-health-value">
                {check === null
                  ? t("device:strip.health.never")
                  : checkPassed
                    ? t("device:strip.health.passed", {
                        time: new Date(check.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                      })
                    : t("device:strip.health.problem")}
              </span>
            }
            testId="strip-health"
            control={
              <RowButton
                disabled={!bound || checking}
                aria-busy={checking || undefined}
                onClick={() => void runCheck()}
                data-testid="strip-health-run"
              >
                <StateSwap
                  fit
                  state={checking ? "busy" : check === null ? "idle" : "again"}
                  faces={{
                    idle: t("device:strip.action.check"),
                    again: t("device:strip.action.checkAgain"),
                    busy: t("device:strip.action.checking"),
                  }}
                />
              </RowButton>
            }
          >
            <Reveal open={check !== null && !checkPassed && !checking}>
              {check && !checkPassed ? (
                <RowNote tone="error" testId="strip-health-failed">
                  {checkKey ? t(checkKey) : check.status.message}
                </RowNote>
              ) : null}
            </Reveal>
          </SettingRow>
        </Reveal>
      </div>
    </section>
  );
}
