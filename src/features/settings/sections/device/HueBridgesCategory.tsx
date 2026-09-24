import { useEffect, useId, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { HueChannelPlacementOverride, HueRuntimeTriggerSource } from "@/shared/contracts/hue";
import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";
import {
  deriveHueBridgeCardState,
  huePairingErrorDescriptionKey,
} from "@/features/hue/model/hueBridgeCardState";
import { buildHueRuntimeStatusCard } from "@/features/hue/model/hueRuntimeStatusCard";
import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import { Button } from "@/shared/ui/Button";
import { cx } from "@/shared/ui/cx";
import { IconBridge, IconHueBridgeGlyph, IconRefresh, IconWifi } from "@/shared/ui/icons";
import { StatusPill } from "@/shared/ui/StatusPill";
import { HueChannelMapPanel } from "../HueChannelMapPanel";
import {
  HUE_CARD_ACTIONS,
  HUE_CARD_CELL_TONE_CLASS,
  HUE_CARD_TONE_CLASS,
  HUE_CARD_VIEW,
  resolveHueCardText,
  withAreaChange,
  type HueCardActionSpec,
  type HueCardContext,
  type HueCardView,
} from "./hueCardView";
import { useHueAreaChoice } from "./useHueAreaChoice";

export interface HueBridgesCategoryProps {
  isActive: boolean;
  /** Mounted once by the parent. Calling `useHueOnboarding()` here would open a
   *  second polling loop; the bridge throttles and drops the stream under two. */
  hue: UseHueOnboardingResult;
  channelPlacements: HueChannelPlacement[];
  onPositionChange: (updated: HueChannelPlacement[]) => Promise<void>;
  /** What was last written to the bridge for the selected area. */
  syncedPositions?: HueChannelPlacementOverride[];
  onNavigateToRoomMap?: () => void;
  onSyncedPositionsChange?: (snapshot: HueChannelPlacementOverride[]) => Promise<void>;
  persistError: boolean;
  /** Room-map zones, so the channel map can project through a bound channel's
   *  zone instead of writing the absolute pair the runtime ignores. */
  zones: readonly HueZone[];
  /** Stop retrying and Stop Hue. Not `stopHue`: a running mode that names Hue
   *  has to let go of it first, which only the mode orchestrator can do. */
  onStopHue: (triggerSource: HueRuntimeTriggerSource) => Promise<void>;
}

export function HueBridgesCategory({
  isActive,
  hue,
  channelPlacements,
  onPositionChange,
  syncedPositions,
  onSyncedPositionsChange,
  onNavigateToRoomMap,
  persistError,
  zones,
  onStopHue,
}: HueBridgesCategoryProps) {
  const { t } = useTranslation();
  const manualIpFieldId = useId();
  const {
    bridges,
    selectedBridgeId,
    selectedBridge,
    manualIp,
    manualIpError,
    credentialState,
    bridgeUnreachable,
    selectedAreaId,
    selectedArea,
    canStartHue,
    isReadinessStale,
    isDiscovering: isHueDiscovering,
    isPairing: isHuePairing,
    isLoadingAreas,
    isCheckingReadiness,
    isValidatingCredential,
    credentials,
    status: hueStatus,
    runtimeStatus,
    runtimeStatusReadFailure,
    isRuntimeMutating,
    areaChannels,
    isLoadingChannels,
    channelsStatus,
    channelsFromBridge,
    refreshChannels,
    discover,
    setManualIp,
    submitManualIp,
    pair,
  } = hue;

  const hueManualIpDisabled = isHueDiscovering || !manualIp || Boolean(manualIpError);
  const manualIpDescriptionId = `${manualIpFieldId}-description`;
  const manualIpErrorId = `${manualIpFieldId}-error`;

  const hueBridgeState = deriveHueBridgeCardState({
    selectedBridgeId,
    runtimeStatus,
    runtimeStatusUnavailable: runtimeStatusReadFailure !== null,
    hueStatus,
    credentialState,
    bridgeUnreachable,
    isPairing: isHuePairing,
    selectedAreaId,
    isReadinessStale,
  });

  const stateView: HueCardView | null = hueBridgeState ? HUE_CARD_VIEW[hueBridgeState] : null;
  const areaChoice = useHueAreaChoice(hue, stateView?.actions.includes("changeArea") ?? false);

  const cardContext: HueCardContext = {
    t,
    hue,
    runtimeModel: buildHueRuntimeStatusCard({ status: runtimeStatus }),
    pairingErrorKey: huePairingErrorDescriptionKey(hueStatus?.code),
    gates: {
      areasDisabled: !selectedBridge || credentialState !== "valid" || isLoadingAreas,
      readinessDisabled: !selectedBridge || !selectedAreaId || credentialState !== "valid" || isCheckingReadiness,
      startDisabled:
        !canStartHue
        || isValidatingCredential
        || credentialState !== "valid"
        || isReadinessStale
        || isRuntimeMutating,
    },
    onStopHue,
    areaChoice,
  };
  const view = stateView && areaChoice.changing ? withAreaChange(stateView) : stateView;

  const hueIsDiscoveryFailed = !isHueDiscovering && !selectedBridgeId && hueStatus?.code === "HUE_DISCOVERY_FAILED";
  const hueIsDiscoveryEmpty = !isHueDiscovering && !selectedBridgeId && hueStatus !== null && bridges.length === 0 && !hueIsDiscoveryFailed;

  return (
    <div className="lm-device-cat-body" hidden={!isActive}>
      <div className="lm-device-head">
        <div>
          <h1>{t("device:page.header.hueTitle")}</h1>
          <div className="lm-device-head-sub" role="status" aria-live="polite">
            {view ? resolveHueCardText(view.subtitle, cardContext) : t("device:page.header.hueSub")}
          </div>
        </div>
        <div className="lm-device-head-actions">
          <Button onClick={() => { void discover(); }} busy={isHueDiscovering}>
            <IconRefresh />
            <span>{isHueDiscovering ? t("hue:page.scanning") : t("hue:page.scanNetwork")}</span>
          </Button>
        </div>
      </div>

      {/* ── Hue content area ── */}
      <div className="lm-device-grid">
        {!selectedBridgeId ? (
          /* ── No bridge selected ── */
          isHueDiscovering ? (
            /* State J: Discovering ghost card */
            <div className="lm-hue-scan-card">
              <span className="lm-hue-wait-sp" aria-hidden="true" />
              <span style={{ fontFamily: "var(--lm-mono)", fontSize: "10px", color: "var(--lm-ink-faint)", letterSpacing: "0.04em" }}>
                {t("hue:page.scanningDetail")}
              </span>
            </div>
          ) : bridges.length > 0 ? (
            /* Bridge list — pick one to pair */
            <>
              {bridges.map((bridge) => (
                <FoundBridgeCard key={bridge.id} bridge={bridge} pairLabel={t("hue:page.addBridge")} onPair={() => { void pair(bridge.id); }}>
                  <StatusPill tone="warn">{t("hue:page.pill.discovered")}</StatusPill>
                </FoundBridgeCard>
              ))}
            </>
          ) : hueIsDiscoveryFailed ? (
            /* State K2: Discovery failed */
            <HueHero icon={<IconWifi />} title={t("hue:page.scanFailed")} body={t("hue:page.scanFailedBody")}>
              <Button size="card" onClick={() => { void discover(); }}>{t("hue:page.scanAgain")}</Button>
            </HueHero>
          ) : hueIsDiscoveryEmpty ? (
            /* State K1: Discovery empty */
            <HueHero icon={<IconBridge />} title={t("hue:page.noResult")} body={t("hue:page.noResultBody")}>
              <Button size="card" onClick={() => { void discover(); }}>{t("hue:page.scanAgain")}</Button>
            </HueHero>
          ) : (
            /* State I: Empty hero — initial state */
            <HueHero icon={<IconBridge />} title={t("hue:wizard.emptyTitle")} body={t("hue:wizard.emptyBody")}>
              <Button size="card" onClick={() => { void discover(); }}>{t("hue:wizard.emptyAction")}</Button>
            </HueHero>
          )
        ) : selectedBridge && view ? (
          <>
            <HueBridgeCard name={selectedBridge.name} ip={selectedBridge.ip} view={view} ctx={cardContext} />

            {/* Channel map panel — shown when area is selected and credentials valid */}
            {selectedAreaId && credentialState === "valid" ? (
              <HueChannelMapPanel
                channels={areaChannels}
                isLoading={isLoadingChannels}
                channelsStatus={channelsStatus}
                channelsFromBridge={channelsFromBridge}
                syncedPositions={syncedPositions}
                onSyncedPositionsChange={(snapshot) => { void onSyncedPositionsChange?.(snapshot); }}
                onRefreshChannels={refreshChannels}
                onRepair={() => { void pair(); }}
                onNavigateToRoomMap={onNavigateToRoomMap}
                placements={channelPlacements}
                onPositionChange={onPositionChange}
                persistError={persistError}
                bridgeIp={selectedBridge?.ip}
                username={credentials?.username}
                areaId={selectedArea?.id}
                isStreaming={runtimeStatus?.state === "Running"}
                zones={zones}
              />
            ) : null}
          </>
        ) : null}

        {/* Manual IP form — visible when no bridge selected */}
        {!selectedBridgeId ? (
          <div className="lm-hue-ip-form">
            <div>
              <div className="lm-hue-ip-form-title">{t("hue:manualIp.title")}</div>
              <div className="lm-hue-ip-form-sub" id={manualIpDescriptionId}>{t("hue:manualIp.description")}</div>
            </div>
            <div className="lm-hue-ip-row">
              <input
                className="lm-hue-ip-input"
                value={manualIp}
                onChange={(e) => { setManualIp(e.target.value); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !hueManualIpDisabled) {
                    e.preventDefault();
                    void submitManualIp();
                  }
                }}
                placeholder={t("hue:manualIp.placeholder")}
                aria-label={t("hue:manualIp.inputLabel")}
                aria-describedby={manualIpError ? `${manualIpDescriptionId} ${manualIpErrorId}` : manualIpDescriptionId}
                aria-invalid={manualIpError ? true : undefined}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                className="lm-hue-ip-submit"
                onClick={() => { void submitManualIp(); }}
                disabled={hueManualIpDisabled}
              >
                {t("hue:page.enterIp")}
              </button>
            </div>
            {manualIpError ? <div className="lm-hue-ip-error" id={manualIpErrorId}>{t(manualIpError)}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface HueHeroProps {
  icon: ReactNode;
  title: string;
  body: string;
  /** The one next step. */
  children: ReactNode;
}

function HueHero({ icon, title, body, children }: HueHeroProps) {
  return (
    <div className="lm-hue-hero">
      <div className="lm-hue-hero-ic">{icon}</div>
      <p className="lm-hue-hero-title">{title}</p>
      <p className="lm-hue-hero-sub">{body}</p>
      <div className="lm-hue-hero-btns">{children}</div>
    </div>
  );
}

interface FoundBridgeCardProps {
  bridge: { id: string; name: string; ip: string };
  pairLabel: string;
  onPair: () => void;
  /** The pill beside the name. */
  children: ReactNode;
}

/**
 * A bridge discovery found. Static, with "+ Pair" as its one control: the
 * card itself used to be a `role="button"` wrapped round that button, and it
 * did something else — it selected the bridge without pairing, which an
 * unpaired machine showed as expired credentials. The button names the bridge
 * it pairs, since a list of them all reads "+ Pair".
 */
function FoundBridgeCard({ bridge, pairLabel, onPair, children }: FoundBridgeCardProps) {
  const nameId = useId();
  return (
    <div className="lm-dcard is-ghost">
      <div className="lm-dcard-head">
        <div className="lm-dcard-ic"><IconHueBridgeGlyph /></div>
        <div className="lm-dcard-tx">
          <div className="lm-dcard-name">
            <span id={nameId}>{bridge.name}</span>
            {children}
          </div>
          <div className="lm-dcard-sub">{bridge.ip}</div>
        </div>
      </div>
      <div className="lm-dcard-actions">
        <Button size="card" onClick={onPair} aria-describedby={nameId}>
          {pairLabel}
        </Button>
      </div>
    </div>
  );
}

interface HueBridgeCardProps {
  name: string;
  ip: string;
  view: HueCardView;
  ctx: HueCardContext;
}

/** The selected bridge's card, drawn entirely from its state's row in `HUE_CARD_VIEW`. */
function HueBridgeCard({ name, ip, view, ctx }: HueBridgeCardProps) {
  const cells = view.cells(ctx);
  const actions = view.actions.flatMap((id) => {
    const action: HueCardActionSpec | null = HUE_CARD_ACTIONS[id](ctx);
    return action ? [{ id, ...action }] : [];
  });

  // Confirm and Cancel unmount with the list; hand focus back to the button
  // that opened it rather than to the document.
  const footerRef = useRef<HTMLDivElement | null>(null);
  const changing = ctx.areaChoice.changing;
  const wasChanging = useRef(changing);
  useEffect(() => {
    const closed = wasChanging.current && !changing;
    wasChanging.current = changing;
    if (!closed || (document.activeElement !== null && document.activeElement !== document.body)) return;
    footerRef.current?.querySelector<HTMLElement>('[data-action="changeArea"]')?.focus();
  }, [changing]);
  return (
    <div className={cx("lm-dcard", view.tone && HUE_CARD_TONE_CLASS[view.tone])}>
      <div className="lm-dcard-head">
        <div className="lm-dcard-ic"><IconHueBridgeGlyph /></div>
        <div className="lm-dcard-tx">
          <div className="lm-dcard-name">
            <span>{name}</span>
            <StatusPill tone={view.pill.tone}>{ctx.t(view.pill.label)}</StatusPill>
          </div>
          <div className="lm-dcard-sub">{ip}</div>
        </div>
      </div>

      {view.lead?.(ctx)}

      {cells.length > 0 ? (
        <div className="lm-dcard-body">
          {cells.map((cell) => (
            <div key={cell.label} className="lm-dcard-cell">
              <div className="lm-dcard-cell-k">{ctx.t(cell.label)}</div>
              <div className={cx("lm-dcard-cell-v", cell.tone && HUE_CARD_CELL_TONE_CLASS[cell.tone])}>
                {cell.value}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {view.detail?.(ctx)}

      <div className="lm-dcard-actions" ref={footerRef}>
        {actions.map(({ id, label, onClick, disabled, busy, danger, primary }) => (
          <Button
            key={id}
            size="card"
            variant={danger ? "danger" : primary ? "primary" : "secondary"}
            onClick={onClick}
            disabled={disabled}
            busy={busy}
            data-action={id}
          >
            {label}
          </Button>
        ))}
      </div>
    </div>
  );
}
