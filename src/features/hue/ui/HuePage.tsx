import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  HUE_FORGET_STATUS,
  type HueChannelPlacementOverride,
  type HueForgetStatus,
  type HueOffBehavior,
  type HueRuntimeTriggerSource,
} from "@/shared/contracts/hue";
import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";
import { isAreaHeldByAnotherApp } from "@/features/hue/model/areaGrouping";
import { bridgeDisplayName } from "@/features/hue/model/bridgeIdentity";
import { deriveHueBridgeCardState, huePairingErrorDescriptionKey } from "@/features/hue/model/hueBridgeCardState";
import { buildHueRuntimeStatusCard } from "@/features/hue/model/hueRuntimeStatusCard";
import type { HueBridgeSummary } from "@/features/hue/hueOnboardingApi";
import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import { HueChannels } from "@/features/hue/ui/HueChannels";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { cx } from "@/shared/ui/cx";
import { Reveal } from "@/shared/ui/Reveal/Reveal";
import { RowButton, SettingRow } from "@/shared/ui/SettingRow/SettingRow";

import { HueAddressRow } from "./HueAddressRow";
import { HueAreaRow } from "./HueAreaRow";
import { HueBridgeRow, HueNoteLine } from "./HueBridgeRow";
import { HueOffBehaviorRow } from "./HueOffBehaviorRow";
import { HUE_ACTIONS, HUE_STATE_VIEW, resolveActions, type HueContext, type HueTone } from "./hueStateView";
import { useHueAreaChoice } from "./useHueAreaChoice";
import styles from "./HuePage.module.css";

export interface HuePageProps {
  isActive: boolean;
  /** Mounted once by the parent. Calling `useHueOnboarding()` here would open a second polling
   *  loop; the bridge throttles and drops the stream under two. */
  hue: UseHueOnboardingResult;
  /** A bridge found on the network that the rail opened, rather than the paired one. */
  foundBridge?: HueBridgeSummary | null;
  channelPlacements: HueChannelPlacement[];
  onPositionChange: (updated: HueChannelPlacement[]) => Promise<void>;
  /** What was last written to the bridge for the selected area. */
  syncedPositions?: HueChannelPlacementOverride[];
  onNavigateToRoomMap?: () => void;
  onSyncedPositionsChange?: (snapshot: HueChannelPlacementOverride[]) => Promise<void>;
  persistError: boolean;
  /** Room-map zones, so the channel map can project through a bound channel's zone instead of
   *  writing the absolute pair the runtime ignores. */
  zones: readonly HueZone[];
  /** Stop retrying and Stop Hue. Not `stopHue`: a running mode that names Hue has to let go of it
   *  first, which only the mode orchestrator can do. */
  onStopHue: (triggerSource: HueRuntimeTriggerSource) => Promise<void>;
  /** What Off does to the Hue lights; `null` until the saved value is read. */
  offBehavior?: HueOffBehavior | null;
  /** Saves the choice. Absent ⇒ the choice is not shown. */
  onOffBehaviorChange?: (next: HueOffBehavior) => void;
}

/** The Hue bridge: its state in a word, one amber action, the area and what Off does. */
export function HuePage({
  isActive,
  hue,
  foundBridge = null,
  channelPlacements,
  onPositionChange,
  syncedPositions,
  onSyncedPositionsChange,
  onNavigateToRoomMap,
  persistError,
  zones,
  onStopHue,
  offBehavior = null,
  onOffBehaviorChange,
}: HuePageProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const {
    selectedBridgeId,
    selectedBridge,
    credentialState,
    selectedAreaId,
    selectedArea,
    credentials,
    runtimeStatus,
  } = hue;

  const state = deriveHueBridgeCardState({
    selectedBridgeId,
    runtimeStatus,
    runtimeStatusUnavailable: hue.runtimeStatusReadFailure !== null,
    hueStatus: hue.status,
    credentialState,
    hasCredentials: credentials !== null,
    bridgeUnreachable: hue.bridgeUnreachable,
    isPairing: hue.isPairing,
    selectedAreaId,
    isReadinessStale: hue.isReadinessStale,
    areaHeldByAnotherApp: isAreaHeldByAnotherApp(selectedArea),
  });
  const view = state ? HUE_STATE_VIEW[state] : null;
  const areaChoice = useHueAreaChoice(hue, view?.area === "change");

  const [forgetOpen, setForgetOpen] = useState(false);
  const [isForgetting, setIsForgetting] = useState(false);
  const [forgetResult, setForgetResult] = useState<HueForgetStatus | null>(null);
  const { forgetBridge, selectBridge } = hue;
  // A bridge with no key has nothing saved to forget: letting go of the selection is the whole of
  // it, and asking first would overstate it.
  const requestForget = useCallback(() => {
    setForgetResult(null);
    if (credentials === null) {
      selectBridge(null);
      return;
    }
    setForgetOpen(true);
  }, [credentials, selectBridge]);
  // The note is about the bridge that was forgotten; a bridge selected since (a new pairing, a
  // scan with one result) is another story.
  const selectedAfterForget = forgetResult?.code !== HUE_FORGET_STATUS.FAILED && selectedBridgeId !== null;
  useEffect(() => {
    if (selectedAfterForget) setForgetResult(null);
  }, [selectedAfterForget]);
  const confirmForget = useCallback(async () => {
    setForgetOpen(false);
    setIsForgetting(true);
    try {
      setForgetResult(await forgetBridge());
    } finally {
      setIsForgetting(false);
    }
  }, [forgetBridge]);

  const ctx: HueContext = {
    t,
    hue,
    runtimeModel: buildHueRuntimeStatusCard({ status: runtimeStatus }),
    pairingErrorKey: huePairingErrorDescriptionKey(hue.status?.code),
    gates: {
      areasDisabled: !selectedBridge || credentialState !== "valid" || hue.isLoadingAreas,
      readinessDisabled: !selectedBridge || !selectedAreaId || credentialState !== "valid" || hue.isCheckingReadiness,
      startDisabled:
        !hue.canStartHue ||
        hue.isValidatingCredential ||
        credentialState !== "valid" ||
        hue.isReadinessStale ||
        hue.isRuntimeMutating,
    },
    onStopHue,
    areaChoice,
    requestForget,
    isForgetting,
  };

  // The rail opened a bridge that is not the one in use (a pairing of it shows its own state).
  const showsFound = foundBridge !== null && foundBridge.id !== selectedBridgeId;
  const title = showsFound
    ? bridgeDisplayName(foundBridge.name)
    : selectedBridge
      ? bridgeDisplayName(selectedBridge.name)
      : t("hue:page.title");

  // A found bridge and the paired one are two pages: moving between them rises in like a rail
  // switch. The first showing does not; the pane's own entrance covers it.
  const bodyKey = showsFound ? `found:${foundBridge.id}` : "bridge";
  const [lastBodyKey, setLastBodyKey] = useState(bodyKey);
  const [bodyMoved, setBodyMoved] = useState(false);
  if (bodyKey !== lastBodyKey) {
    setLastBodyKey(bodyKey);
    setBodyMoved(true);
  }

  let body: ReactNode;
  if (showsFound) {
    body = (
      <div className={styles.rows}>
        <FoundBridgeRows
        bridge={foundBridge}
        replaces={credentials !== null && selectedBridge ? bridgeDisplayName(selectedBridge.name) : null}
        // The stream is the paired bridge's, and this page has no way to stop it.
        streaming={runtimeStatus !== null && runtimeStatus.state !== "Idle" && runtimeStatus.state !== "Failed"}
        onPair={() => {
          void hue.pair(foundBridge.id);
        }}
      />
      </div>
    );
  } else if (!selectedBridgeId) {
    body = (
      <div className={styles.rows}>
        <NoBridgeRows hue={hue} forgetResult={forgetResult} />
      </div>
    );
  } else if (selectedBridge && view) {
    const primary = view.primary === null ? null : (resolveActions([view.primary], ctx)[0] ?? null);
    const change = view.area === "change" ? HUE_ACTIONS.changeArea(ctx) : null;
    const showsArea = view.area === "change" || (view.area === "show" && selectedArea !== null);
    body = (
      <>
        <div className={styles.rows}>
          <Reveal open>
            <HueBridgeRow
              stateKey={state ?? "none"}
              address={selectedBridge.ip}
          word={t(view.word)}
          tone={view.tone}
          note={view.note?.(ctx) ?? null}
          primary={primary?.id === "changeArea" ? null : primary}
          secondary={resolveActions(view.secondary, ctx)}
          more={resolveActions(view.more, ctx)}
              moreLabel={t("hue:page.more", { name: title })}
            >
              <Reveal open={forgetResult !== null}>
                {forgetResult ? <ForgetResultNote result={forgetResult} /> : null}
              </Reveal>
            </HueBridgeRow>
          </Reveal>
          <Reveal open={showsArea}>
            <HueAreaRow
              hue={hue}
              choice={areaChoice}
              change={change}
              refresh={{ id: "refreshAreas", ...HUE_ACTIONS.refreshAreas(ctx) }}
              primary={view.primary === "changeArea"}
            />
          </Reveal>
          <Reveal open={state === "offline"}>
            {state === "offline" ? <HueAddressRow hue={hue} hint={t("hue:manualIp.movedDescription")} /> : null}
          </Reveal>
          {onOffBehaviorChange ? (
            <Reveal open>
              <HueOffBehaviorRow value={offBehavior} onChange={onOffBehaviorChange} />
            </Reveal>
          ) : null}
        </div>

        {selectedAreaId && credentialState === "valid" ? (
          <HueChannels
            channels={hue.areaChannels}
            isLoading={hue.isLoadingChannels}
            channelsStatus={hue.channelsStatus}
            channelsFromBridge={hue.channelsFromBridge}
            syncedPositions={syncedPositions}
            onSyncedPositionsChange={(snapshot) => {
              void onSyncedPositionsChange?.(snapshot);
            }}
            onRefreshChannels={hue.refreshChannels}
            onRepair={() => {
              void hue.pair();
            }}
            onNavigateToRoomMap={onNavigateToRoomMap}
            placements={channelPlacements}
            onPositionChange={onPositionChange}
            persistError={persistError}
            bridgeIp={selectedBridge.ip}
            username={credentials?.username}
            areaId={selectedArea?.id}
            isStreaming={runtimeStatus?.state === "Running"}
            zones={zones}
            lightNames={hue.lightNames}
            onIdentify={hue.identifyLights}
          />
        ) : null}
      </>
    );
  } else {
    body = null;
  }

  return (
    <section className={styles.page} hidden={!isActive} aria-labelledby={headingId} data-testid="hue-page">
      <div key={bodyKey} className={cx(bodyMoved && styles.arrive)}>
        <h1 id={headingId} className={styles.title}>
          {title}
        </h1>
        {body}
      </div>

      {forgetOpen ? (
        <ConfirmDialog
          title={t("hue:page.forgetConfirm.title")}
          body={t("hue:page.forgetConfirm.body")}
          confirmLabel={t("hue:page.forgetConfirm.confirm")}
          cancelLabel={t("hue:page.cancel")}
          tone="danger"
          enterCancels
          onConfirm={() => {
            void confirmForget();
          }}
          onCancel={() => setForgetOpen(false)}
          testId="hue-forget-confirm"
          confirmTestId="hue-forget-confirm-yes"
        />
      ) : null}
    </section>
  );
}

const FORGET_RESULT_KEY = {
  [HUE_FORGET_STATUS.OK]: "hue:page.forgetResult.ok",
  [HUE_FORGET_STATUS.PARTIAL]: "hue:page.forgetResult.partial",
  [HUE_FORGET_STATUS.FAILED]: "hue:page.forgetResult.failed",
} as const;

/** What forgetting did, with the code behind ⓘ unless it all went as asked. */
function ForgetResultNote({ result }: { result: HueForgetStatus }) {
  const { t } = useTranslation();
  return (
    <HueNoteLine
      error={result.code === HUE_FORGET_STATUS.FAILED}
      note={{
        lines: [t(FORGET_RESULT_KEY[result.code])],
        code: result.code === HUE_FORGET_STATUS.OK ? null : result.code,
        testId: "hue-forget-result",
      }}
    />
  );
}

interface NoBridgeRowsProps {
  hue: UseHueOnboardingResult;
  /** What forgetting did; the bridge it was about is gone by now, so this page says it. */
  forgetResult: HueForgetStatus | null;
}

/** No bridge in use: search the network, pair one it found, or type an address. */
function NoBridgeRows({ hue, forgetResult }: NoBridgeRowsProps) {
  const { t } = useTranslation();
  const { bridges, isDiscovering, status, discover, pair } = hue;
  const searchFailed = !isDiscovering && status?.code === "HUE_DISCOVERY_FAILED";
  const noneFound = !isDiscovering && status !== null && bridges.length === 0 && !searchFailed;
  const [tone, word]: [HueTone, string] = isDiscovering
    ? ["busy", t("hue:state.searching")]
    : searchFailed
      ? ["error", t("hue:state.searchFailed")]
      : noneFound
        ? ["warn", t("hue:state.noneFound")]
        : ["idle", t("hue:state.none")];
  const sameName = (bridge: HueBridgeSummary) =>
    bridges.some((other) => other.id !== bridge.id && bridgeDisplayName(other.name) === bridgeDisplayName(bridge.name));

  return (
    <>
      <Reveal open>
        <HueBridgeRow
          stateKey={tone}
          word={word}
          tone={tone}
          note={null}
          // The word says it is searching; the button only waits.
          primary={
            bridges.length === 0
              ? { id: "discover", label: t("hue:page.scanNetwork"), busy: isDiscovering, onClick: () => void discover() }
              : null
          }
          secondary={
            bridges.length === 0
              ? []
              : [{ id: "discover", label: t("hue:page.scanNetwork"), busy: isDiscovering, onClick: () => void discover() }]
          }
          more={[]}
          moreLabel=""
        >
          <Reveal open={forgetResult !== null}>
            {forgetResult ? <ForgetResultNote result={forgetResult} /> : null}
          </Reveal>
        </HueBridgeRow>
      </Reveal>
      {bridges.map((bridge) => {
        const name = sameName(bridge) ? bridge.ip : bridgeDisplayName(bridge.name);
        return (
          <Reveal key={bridge.id} open appear>
            <SettingRow
              label={name}
              value={bridge.ip}
              testId="hue-found-bridge"
              control={
                <RowButton
                  primary={bridges.length === 1}
                  aria-label={t("hue:page.pairNamed", { name })}
                  onClick={() => {
                    void pair(bridge.id);
                  }}
                >
                  {t("hue:page.pair")}
                </RowButton>
              }
            />
          </Reveal>
        );
      })}
      <Reveal open>
        <HueAddressRow hue={hue} hint={t("hue:manualIp.description")} />
      </Reveal>
    </>
  );
}

interface FoundBridgeRowsProps {
  bridge: HueBridgeSummary;
  /** The bridge in use, which pairing this one replaces. */
  replaces: string | null;
  /** Hue runs on the bridge in use: pairing waits until it is stopped. */
  streaming: boolean;
  onPair: () => void;
}

/** A bridge the network answered with, not paired: pairing it is the one thing to do. */
function FoundBridgeRows({ bridge, replaces, streaming, onPair }: FoundBridgeRowsProps) {
  const { t } = useTranslation();
  const lines =
    replaces === null
      ? [t("hue:pair.promptHint")]
      : streaming
        ? [t("hue:page.replaces", { name: replaces }), t("hue:page.stopFirst")]
        : [t("hue:page.replaces", { name: replaces }), t("hue:pair.promptHint")];
  return (
    <Reveal open>
      <HueBridgeRow
      stateKey="found"
      address={bridge.ip}
      word={t("hue:state.unpaired")}
      tone="idle"
      note={{ lines, testId: "hue-pair-prompt" }}
      primary={{ id: "pairBridge", label: t("hue:page.pair"), onClick: onPair, disabled: replaces !== null && streaming }}
      secondary={[]}
      more={[]}
      moreLabel=""
    />
    </Reveal>
  );
}
