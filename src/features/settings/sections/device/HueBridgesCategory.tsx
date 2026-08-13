import { useTranslation } from "react-i18next";

import { HUE_RUNTIME_TRIGGER_SOURCE } from "@/shared/contracts/hue";
import type { HueChannelPlacement } from "@/shared/contracts/roomMap";
import { deriveHueBridgeCardState } from "@/features/hue/model/hueBridgeCardState";
import { buildHueRuntimeStatusCard } from "@/features/hue/model/hueRuntimeStatusCard";
import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import { stopHue } from "@/features/mode/modeApi";
import { HueChannelMapPanel } from "../HueChannelMapPanel";
import {
  IconBridge,
  IconCheck,
  IconHueBridgeGlyph,
  IconInfo,
  IconRefresh,
  IconWifi,
} from "@/shared/ui/icons";

export interface HueBridgesCategoryProps {
  isActive: boolean;
  /** Mounted once by the parent. Calling `useHueOnboarding()` here would open a
   *  second polling loop; the bridge throttles and drops the stream under two. */
  hue: UseHueOnboardingResult;
  channelPlacements: HueChannelPlacement[];
  onPositionChange: (updated: HueChannelPlacement[]) => Promise<void>;
  persistError: boolean;
}

export function HueBridgesCategory({
  isActive,
  hue,
  channelPlacements,
  onPositionChange,
  persistError,
}: HueBridgesCategoryProps) {
  const { t } = useTranslation();
  const {
    bridges,
    selectedBridgeId,
    selectedBridge,
    manualIp,
    manualIpError,
    credentialState,
    bridgeUnreachable,
    areaGroups,
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
    runtimeTargets,
    isRuntimeMutating,
    areaChannels,
    isLoadingChannels,
    channelRegionOverrides,
    setChannelRegion,
    discover,
    selectBridge,
    setManualIp,
    submitManualIp,
    pair,
    refreshAreas,
    selectArea,
    revalidateArea,
    startRuntime,
    retryRuntimeTarget,
  } = hue;

  const hueManualIpDisabled = isHueDiscovering || !manualIp || Boolean(manualIpError);
  const hueAreasDisabled = !selectedBridge || credentialState !== "valid" || isLoadingAreas;
  const hueReadinessDisabled = !selectedBridge || !selectedAreaId || credentialState !== "valid" || isCheckingReadiness;
  const hueStartDisabled =
    !canStartHue
    || isValidatingCredential
    || credentialState !== "valid"
    || isReadinessStale
    || isRuntimeMutating;

  const hueRuntimeModel = buildHueRuntimeStatusCard({
    status: runtimeStatus,
  });

  const hueBridgeState = deriveHueBridgeCardState({
    selectedBridgeId,
    runtimeStatus,
    hueStatus,
    credentialState,
    bridgeUnreachable,
    isPairing: isHuePairing,
    selectedAreaId,
    isReadinessStale,
  });

  const hueIsDiscoveryFailed = !isHueDiscovering && !selectedBridgeId && hueStatus?.code === "HUE_DISCOVERY_FAILED";
  const hueIsDiscoveryEmpty = !isHueDiscovering && !selectedBridgeId && hueStatus !== null && bridges.length === 0 && !hueIsDiscoveryFailed;

  return (
    <div className={isActive ? "lm-device-cat-body" : "lm-device-cat-body hidden"} hidden={!isActive}>
      <div className="lm-device-head">
        <div>
          <h1>{t("device:page.header.hueTitle")}</h1>
          <div className="lm-device-head-sub" role="status" aria-live="polite">
            {hueBridgeState === "streaming"
              ? t("hue:card.subtitleStreaming", { area: selectedArea?.name ?? "—" })
              : hueBridgeState === "idle"
              ? `${selectedArea?.name ?? "—"} · ${t("hue:page.pill.ready").toLowerCase()}`
              : hueBridgeState === "pairing" || hueBridgeState === "pairingLinkButton"
              ? t("hue:wizard.pairingStep")
              : hueBridgeState === "areaSelect"
              ? t("hue:wizard.areaStep")
              : hueBridgeState === "authError"
              ? t("hue:credential.needsRepair")
              : hueBridgeState === "pairingFailed"
              ? t("hue:wizard.pairingFailed")
              : hueBridgeState === "offline"
              ? t("hue:bridge.unreachable")
              : hueBridgeState === "reconnecting"
              ? t("hue:runtime.reconnectingTitle")
              : hueBridgeState === "stale"
              ? t("hue:runtime.checklist.revalidate")
              : hueBridgeState === "gateBlocked"
              ? t("hue:runtime.checklist.title")
              : hueBridgeState === "stopPartial"
              ? t("hue:runtime.timeout.title")
              : t("device:page.header.hueSub")}
          </div>
        </div>
        <div className="lm-device-head-actions">
          <button
            type="button"
            className="lm-device-btn"
            onClick={() => { void discover(); }}
            disabled={isHueDiscovering} aria-busy={isHueDiscovering}
          >
            <IconRefresh />
            <span>{isHueDiscovering ? t("hue:page.scanning") : hueBridgeState === "offline" ? t("hue:wizard.offlineRediscover") : t("hue:page.scanNetwork")}</span>
          </button>
        </div>
      </div>

      {/* ── Hue content area ── */}
      <div className="lm-device-grid">
        {!selectedBridgeId ? (
          /* ── No bridge selected ── */
          isHueDiscovering ? (
            /* State J: Discovering ghost card */
            <div className="lm-hue-scan-card">
              <span className="lm-hue-wait-sp" />
              <span style={{ fontFamily: "var(--lm-mono)", fontSize: "10px", color: "var(--lm-ink-faint)", letterSpacing: "0.04em" }}>
                {t("hue:page.scanningDetail")}
              </span>
            </div>
          ) : bridges.length > 0 ? (
            /* Bridge list — pick one to pair */
            <>
              {bridges.map((bridge) => (
                <div
                  key={bridge.id}
                  role="button"
                  tabIndex={0}
                  className="lm-dcard is-ghost"
                  onClick={() => { selectBridge(bridge.id); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectBridge(bridge.id); } }}
                >
                  <div className="lm-dcard-head">
                    <div className="lm-dcard-ic"><IconHueBridgeGlyph /></div>
                    <div className="lm-dcard-tx">
                      <div className="lm-dcard-name">
                        <span>{bridge.name}</span>
                        <span className="lm-dcard-pill is-warn">{t("hue:page.pill.discovered")}</span>
                      </div>
                      <div className="lm-dcard-sub">{bridge.ip}</div>
                    </div>
                  </div>
                  <div className="lm-dcard-actions">
                    <button
                      type="button"
                      className="lm-dcard-act"
                      onClick={(e) => { e.stopPropagation(); selectBridge(bridge.id); }}
                    >
                      {t("hue:page.addBridge")}
                    </button>
                  </div>
                </div>
              ))}
            </>
          ) : hueIsDiscoveryFailed ? (
            /* State K2: Discovery failed */
            <div className="lm-hue-hero">
              <div className="lm-hue-hero-ic"><IconWifi /></div>
              <p className="lm-hue-hero-title">{t("hue:page.scanFailed")}</p>
              <p className="lm-hue-hero-sub">{t("hue:page.scanFailedBody")}</p>
              <div className="lm-hue-hero-btns">
                <button type="button" className="lm-dcard-act" onClick={() => { void discover(); }}>
                  {t("hue:page.scanAgain")}
                </button>
              </div>
            </div>
          ) : hueIsDiscoveryEmpty ? (
            /* State K1: Discovery empty */
            <div className="lm-hue-hero">
              <div className="lm-hue-hero-ic"><IconBridge /></div>
              <p className="lm-hue-hero-title">{t("hue:page.noResult")}</p>
              <p className="lm-hue-hero-sub">{t("hue:page.noResultBody")}</p>
              <div className="lm-hue-hero-btns">
                <button type="button" className="lm-dcard-act" onClick={() => { void discover(); }}>
                  {t("hue:page.scanAgain")}
                </button>
              </div>
            </div>
          ) : (
            /* State I: Empty hero — initial state */
            <div className="lm-hue-hero">
              <div className="lm-hue-hero-ic"><IconBridge /></div>
              <p className="lm-hue-hero-title">{t("hue:wizard.emptyTitle")}</p>
              <p className="lm-hue-hero-sub">{t("hue:wizard.emptyBody")}</p>
              <div className="lm-hue-hero-btns">
                <button type="button" className="lm-dcard-act" onClick={() => { void discover(); }}>
                  {t("hue:wizard.emptyAction")}
                </button>
              </div>
            </div>
          )
        ) : selectedBridge ? (
          /* ── Bridge selected: card management panel ── */
          <>
            <div className={`lm-dcard${
              hueBridgeState === "streaming" ? " is-on" :
              hueBridgeState === "offline" ? " is-offline" :
              hueBridgeState === "authError" || hueBridgeState === "pairingFailed" || hueBridgeState === "stopPartial" || hueBridgeState === "reconnecting" ? " is-warn-state" :
              hueBridgeState === "stale" ? " is-warn-state" :
              hueBridgeState === "pairing" || hueBridgeState === "pairingLinkButton" || hueBridgeState === "areaSelect" ? " is-ghost" :
              ""
            }`}>
              {/* Card header */}
              <div className="lm-dcard-head">
                <div className="lm-dcard-ic"><IconHueBridgeGlyph /></div>
                <div className="lm-dcard-tx">
                  <div className="lm-dcard-name">
                    <span>{selectedBridge.name}</span>
                    <span className={`lm-dcard-pill${
                      hueBridgeState === "streaming" ? " is-streaming" :
                      hueBridgeState === "idle" ? " is-idle" :
                      hueBridgeState === "areaSelect" ? " is-ok" :
                      hueBridgeState === "offline" || hueBridgeState === "authError" || hueBridgeState === "pairingFailed" || hueBridgeState === "stopPartial" ? " is-error" :
                      " is-warn"
                    }`}>
                      {hueBridgeState === "streaming" ? t("hue:page.pill.streaming") :
                       hueBridgeState === "idle" ? t("hue:page.pill.ready") :
                       hueBridgeState === "pairing" || hueBridgeState === "pairingLinkButton" ? t("hue:page.pill.awaiting") :
                       hueBridgeState === "pairingFailed" ? t("hue:page.pill.failed") :
                       hueBridgeState === "areaSelect" ? t("hue:page.pill.paired") :
                       hueBridgeState === "authError" ? t("hue:page.pill.authError") :
                       hueBridgeState === "offline" ? t("hue:bridge.unreachable") :
                       hueBridgeState === "reconnecting" ? t("hue:page.pill.reconnecting") :
                       hueBridgeState === "stale" || hueBridgeState === "gateBlocked" ? t("hue:page.pill.awaiting") :
                       hueBridgeState === "stopPartial" ? t("hue:page.pill.failed") :
                       ""}
                    </span>
                  </div>
                  <div className="lm-dcard-sub">{selectedBridge.ip}</div>
                </div>
              </div>

              {/* Traffic bar — streaming state only */}
              {hueBridgeState === "streaming" ? (
                <div className="lm-hue-traffic">
                  <div className="lm-hue-traffic-bar">
                    <div className="lm-hue-traffic-fill" />
                  </div>
                  <div className="lm-hue-traffic-label">
                    <span>{t("hue:card.trafficLabel")}</span>
                    <b>DTLS · 20 Hz</b>
                  </div>
                </div>
              ) : null}

              {/* State E: Auth error repair banner — shown BEFORE data cells */}
              {hueBridgeState === "authError" ? (
                <div className="lm-hue-repair is-error">
                  <IconInfo />
                  <div className="lm-hue-repair-tx">
                    <div className="lm-hue-repair-title">{t("hue:credential.needsRepair")}</div>
                    <div className="lm-hue-repair-sub">{t("hue:credential.repairHint")}</div>
                  </div>
                  <button
                    type="button"
                    className="lm-hue-repair-act"
                    onClick={() => { void pair(); }}
                    disabled={isHuePairing} aria-busy={isHuePairing}
                  >
                    {isHuePairing ? t("hue:actions.pairing") : t("hue:runtime.actions.repair")}
                  </button>
                </div>
              ) : null}

              {/* Stats body — state-specific 4-cell layout */}
              {hueBridgeState === "streaming" ? (
                <div className="lm-dcard-body">
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("hue:card.cellArea")}</div>
                    <div className="lm-dcard-cell-v is-am">{selectedArea?.name ?? "—"}</div>
                  </div>
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("hue:card.cellProtocol")}</div>
                    <div className="lm-dcard-cell-v is-dim">DTLS</div>
                  </div>
                  {selectedArea?.channelCount !== undefined ? (
                    <div className="lm-dcard-cell">
                      <div className="lm-dcard-cell-k">{t("hue:card.cellCh")}</div>
                      <div className="lm-dcard-cell-v">{selectedArea.channelCount}</div>
                    </div>
                  ) : null}
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("hue:card.cellRate")}</div>
                    <div className="lm-dcard-cell-v is-am">20 Hz</div>
                  </div>
                </div>
              ) : hueBridgeState === "idle" ? (
                <div className="lm-dcard-body">
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("hue:card.cellArea")}</div>
                    <div className="lm-dcard-cell-v">{selectedArea?.name ?? "—"}</div>
                  </div>
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("hue:card.cellProtocol")}</div>
                    <div className="lm-dcard-cell-v is-dim">DTLS</div>
                  </div>
                  {selectedArea?.channelCount !== undefined ? (
                    <div className="lm-dcard-cell">
                      <div className="lm-dcard-cell-k">{t("hue:card.cellCh")}</div>
                      <div className="lm-dcard-cell-v">{selectedArea.channelCount}</div>
                    </div>
                  ) : null}
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("hue:card.cellStatus")}</div>
                    <div className="lm-dcard-cell-v is-ok">{t("hue:page.pill.ready")}</div>
                  </div>
                </div>
              ) : hueBridgeState === "stale" ? (
                <div className="lm-dcard-body">
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("hue:card.cellArea")}</div>
                    <div className="lm-dcard-cell-v">{selectedArea?.name ?? "—"}</div>
                  </div>
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("hue:card.cellProtocol")}</div>
                    <div className="lm-dcard-cell-v is-dim">DTLS</div>
                  </div>
                  {selectedArea?.channelCount !== undefined ? (
                    <div className="lm-dcard-cell">
                      <div className="lm-dcard-cell-k">{t("hue:card.cellCh")}</div>
                      <div className="lm-dcard-cell-v">{selectedArea.channelCount}</div>
                    </div>
                  ) : null}
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("hue:card.cellStatus")}</div>
                    <div className="lm-dcard-cell-v is-warn">{t("hue:page.pill.awaiting")}</div>
                  </div>
                </div>
              ) : hueBridgeState === "reconnecting" ? (
                <div className="lm-dcard-body">
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("hue:card.cellArea")}</div>
                    <div className="lm-dcard-cell-v is-dim">{selectedArea?.name ?? "—"}</div>
                  </div>
                  {hueStatus?.code ? (
                    <div className="lm-dcard-cell">
                      <div className="lm-dcard-cell-k">{t("hue:card.cellError")}</div>
                      <div className="lm-dcard-cell-v is-error" style={{ fontSize: "9px" }}>{hueStatus.code}</div>
                    </div>
                  ) : null}
                  {hueRuntimeModel.retry?.remainingAttempts !== undefined ? (
                    <div className="lm-dcard-cell">
                      <div className="lm-dcard-cell-k">{t("hue:card.cellRetries")}</div>
                      <div className="lm-dcard-cell-v is-am">{hueRuntimeModel.retry.remainingAttempts}</div>
                    </div>
                  ) : null}
                  {hueRuntimeModel.retry?.nextAttemptMs !== undefined ? (
                    <div className="lm-dcard-cell">
                      <div className="lm-dcard-cell-k">{t("hue:card.cellNext")}</div>
                      <div className="lm-dcard-cell-v is-am">{(hueRuntimeModel.retry.nextAttemptMs / 1000).toFixed(1)} s</div>
                    </div>
                  ) : null}
                </div>
              ) : hueBridgeState === "stopPartial" ? (
                <div className="lm-dcard-body">
                  {selectedArea ? (
                    <div className="lm-dcard-cell">
                      <div className="lm-dcard-cell-k">{t("hue:card.cellArea")}</div>
                      <div className="lm-dcard-cell-v is-dim">{selectedArea.name}</div>
                    </div>
                  ) : null}
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("hue:card.cellFault")}</div>
                    <div className="lm-dcard-cell-v is-am" style={{ fontSize: "9px" }}>HUE_STOP_PARTIAL</div>
                  </div>
                </div>
              ) : hueBridgeState === "gateBlocked" ? (
                <div className="lm-dcard-body">
                  {selectedArea ? (
                    <div className="lm-dcard-cell">
                      <div className="lm-dcard-cell-k">{t("hue:card.cellArea")}</div>
                      <div className="lm-dcard-cell-v is-dim">{selectedArea.name}</div>
                    </div>
                  ) : null}
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("hue:card.cellProtocol")}</div>
                    <div className="lm-dcard-cell-v is-dim">DTLS</div>
                  </div>
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("hue:card.cellConfig")}</div>
                    <div className="lm-dcard-cell-v is-error" style={{ fontSize: "9px" }}>NOT_READY</div>
                  </div>
                </div>
              ) : hueBridgeState === "authError" ? (
                <div className="lm-dcard-body">
                  {selectedArea ? (
                    <div className="lm-dcard-cell">
                      <div className="lm-dcard-cell-k">{t("hue:card.cellArea")}</div>
                      <div className="lm-dcard-cell-v is-dim">{selectedArea.name}</div>
                    </div>
                  ) : null}
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("hue:card.cellCredential")}</div>
                    <div className="lm-dcard-cell-v is-error">{t("hue:card.cellCredentialInvalid")}</div>
                  </div>
                  {hueStatus?.code ? (
                    <div className="lm-dcard-cell">
                      <div className="lm-dcard-cell-k">{t("hue:card.cellFault")}</div>
                      <div className="lm-dcard-cell-v is-warn" style={{ fontSize: "9px" }}>{hueStatus.code}</div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* ── State-specific body content ── */}

              {/* State C/M: Pairing steps (4-step tracker) */}
              {hueBridgeState === "pairing" ? (
                <div className="lm-hue-steps">
                  <div className="lm-hue-step is-done">
                    <span className="lm-hue-step-dot"><IconCheck /></span>
                    <span>{t("hue:steps.discover")}</span>
                  </div>
                  <div className="lm-hue-step-line is-done" />
                  <div className="lm-hue-step is-active">
                    <span className="lm-hue-step-dot" />
                    <span>{t("hue:steps.pair")}</span>
                  </div>
                  <div className="lm-hue-step-line" />
                  <div className="lm-hue-step">
                    <span className="lm-hue-step-dot" />
                    <span>{t("hue:steps.area")}</span>
                  </div>
                  <div className="lm-hue-step-line" />
                  <div className="lm-hue-step">
                    <span className="lm-hue-step-dot" />
                    <span>{t("hue:steps.ready")}</span>
                  </div>
                </div>
              ) : hueBridgeState === "pairingFailed" ? (
                <div className="lm-hue-steps">
                  <div className="lm-hue-step is-done">
                    <span className="lm-hue-step-dot"><IconCheck /></span>
                    <span>{t("hue:steps.discover")}</span>
                  </div>
                  <div className="lm-hue-step-line is-done" />
                  <div className="lm-hue-step is-fail">
                    <span className="lm-hue-step-dot" />
                    <span>{t("hue:steps.pair")}</span>
                  </div>
                  <div className="lm-hue-step-line" />
                  <div className="lm-hue-step">
                    <span className="lm-hue-step-dot" />
                    <span>{t("hue:steps.area")}</span>
                  </div>
                  <div className="lm-hue-step-line" />
                  <div className="lm-hue-step">
                    <span className="lm-hue-step-dot" />
                    <span>{t("hue:steps.ready")}</span>
                  </div>
                </div>
              ) : null}

              {/* State C: Link button wait */}
              {hueBridgeState === "pairingLinkButton" ? (
                <div className="lm-hue-wait">
                  <span className="lm-hue-wait-sp" />
                  <span>{t("hue:pair.linkButtonHint")}</span>
                </div>
              ) : null}

              {/* State D/G: Area selection */}
              {hueBridgeState === "areaSelect" ? (
                <div className="lm-hue-areas">
                  <div className="lm-hue-areas-label">{t("hue:areas.selectLabel")}</div>
                  {areaGroups.length === 0 ? (
                    <p style={{ fontFamily: "var(--lm-mono)", fontSize: "10px", color: "var(--lm-ink-faint)", padding: "4px 0" }}>
                      {t("hue:areas.empty")}
                    </p>
                  ) : (
                    <div className="lm-hue-area-list">
                      {areaGroups.map((group) =>
                        group.areas.map((area) => (
                          <button
                            key={area.id}
                            type="button"
                            className={`lm-hue-area-item${selectedAreaId === area.id ? " is-sel" : ""}${area.activeStreamer ? " is-blocked" : ""}`}
                            onClick={() => { if (!area.activeStreamer) selectArea(area.id); }}
                          >
                            <span className="lm-hue-area-ic" />
                            <span className="lm-hue-area-name">{area.name}</span>
                            <span className="lm-hue-area-ch">{t("hue:areas.channels", { count: area.channelCount ?? 0 })}</span>
                            {area.activeStreamer ? (
                              <span className="lm-hue-area-badge">{t("hue:areas.activeStreamer")}</span>
                            ) : null}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                  {/* State G: Active streamer conflict warning */}
                  {areaGroups.some((g) => g.areas.some((a) => a.activeStreamer && selectedAreaId === a.id)) ? (
                    <div className="lm-hue-repair is-error" style={{ marginTop: "6px" }}>
                      <IconInfo />
                      <div className="lm-hue-repair-tx">
                        <div className="lm-hue-repair-title">{t("hue:areas.conflictTitle")}</div>
                        <div className="lm-hue-repair-sub">{t("hue:areas.conflictHint")}</div>
                      </div>
                    </div>
                  ) : null}
                  {selectedAreaId ? (
                    <button
                      type="button"
                      className="lm-hue-area-confirm"
                      onClick={() => { void revalidateArea(); }}
                      disabled={hueReadinessDisabled} aria-busy={isCheckingReadiness}
                    >
                      {isCheckingReadiness ? t("hue:actions.checkingReadiness") : `${t("hue:page.confirmArea")} →`}
                    </button>
                  ) : null}
                </div>
              ) : null}

              {/* State F: Offline reasons */}
              {hueBridgeState === "offline" ? (
                <div className="lm-hue-offline">
                  <div className="lm-hue-offline-title">{t("hue:wizard.offlineReasonsTitle")}</div>
                  <div className="lm-hue-offline-item">{t("hue:wizard.offlineReason1")}</div>
                  <div className="lm-hue-offline-item">{t("hue:wizard.offlineReason2")}</div>
                  <div className="lm-hue-offline-item">{t("hue:wizard.offlineReason3")}</div>
                </div>
              ) : null}

              {/* State H: Reconnecting retry progress */}
              {hueBridgeState === "reconnecting" ? (
                <div className="lm-hue-retry">
                  <span className="lm-hue-retry-sp" />
                  <span className="lm-hue-retry-tx">
                    {hueRuntimeModel.retry
                      ? t(hueRuntimeModel.retry.labelKey, {
                          remaining: hueRuntimeModel.retry.remainingAttempts ?? "—",
                          nextMs: hueRuntimeModel.retry.nextAttemptMs ?? "—",
                        })
                      : t("hue:runtime.reconnectingTitle")}
                  </span>
                  <button
                    type="button"
                    className="lm-hue-retry-cancel"
                    onClick={() => { void stopHue(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE); }}
                    disabled={isRuntimeMutating} aria-busy={isRuntimeMutating}
                  >
                    {t("hue:page.stopRetrying")}
                  </button>
                </div>
              ) : null}

              {/* State N: Stale readiness */}
              {hueBridgeState === "stale" ? (
                <div className="lm-hue-stale">
                  <IconInfo />
                  <span className="lm-hue-stale-tx">{t("hue:runtime.checklist.revalidate")}</span>
                  <button
                    type="button"
                    className="lm-hue-stale-act"
                    onClick={() => { void revalidateArea(); }}
                    disabled={hueReadinessDisabled} aria-busy={isCheckingReadiness}
                  >
                    {isCheckingReadiness ? t("hue:actions.checkingReadiness") : t("hue:page.validate")}
                  </button>
                </div>
              ) : null}

              {/* State P: Gate blocked checklist */}
              {hueBridgeState === "gateBlocked" ? (
                <div className="lm-hue-checklist">
                  <div className="lm-hue-checklist-title">{t("hue:runtime.checklist.title")}</div>
                  {isReadinessStale ? (
                    <div className="lm-hue-checklist-item">
                      <IconInfo />
                      <span>{t("hue:runtime.checklist.revalidate")}</span>
                    </div>
                  ) : null}
                  <div className="lm-hue-checklist-btns">
                    <button
                      type="button"
                      className="lm-hue-checklist-btn"
                      onClick={() => { void revalidateArea(); }}
                      disabled={hueReadinessDisabled} aria-busy={isCheckingReadiness}
                    >
                      {isCheckingReadiness ? t("hue:actions.checkingReadiness") : t("hue:page.validate")}
                    </button>
                  </div>
                </div>
              ) : null}

              {/* State Q: Stop timeout fault */}
              {hueBridgeState === "stopPartial" ? (
                <div className="lm-hue-fault">
                  {t("hue:runtime.timeout.title")}
                </div>
              ) : null}

              {/* ── Action buttons footer ── */}
              <div className="lm-dcard-actions">
                {hueBridgeState === "streaming" ? (
                  <>
                    <button type="button" className="lm-dcard-act" onClick={() => { void refreshAreas(); }} disabled={hueAreasDisabled} aria-busy={isLoadingAreas}>
                      {t("hue:page.changeArea")}
                    </button>
                    <button type="button" className="lm-dcard-act" onClick={() => { void startRuntime(); }} disabled={isRuntimeMutating || hueStartDisabled} aria-busy={isRuntimeMutating}>
                      {t("hue:page.reconnectNow")}
                    </button>
                    <button type="button" className="lm-dcard-act is-danger" onClick={() => { selectBridge(null); }}>
                      {t("hue:page.forgotBridge")}
                    </button>
                  </>
                ) : hueBridgeState === "idle" ? (
                  <>
                    <button type="button" className="lm-dcard-act" onClick={() => { void refreshAreas(); }} disabled={hueAreasDisabled} aria-busy={isLoadingAreas}>
                      {t("hue:page.changeArea")}
                    </button>
                    <button type="button" className="lm-dcard-act" onClick={() => { void revalidateArea(); }} disabled={hueReadinessDisabled} aria-busy={isCheckingReadiness}>
                      {isCheckingReadiness ? t("hue:actions.checkingReadiness") : t("hue:page.validate")}
                    </button>
                    <button type="button" className="lm-dcard-act is-danger" onClick={() => { selectBridge(null); }}>
                      {t("hue:page.forgotBridge")}
                    </button>
                  </>
                ) : hueBridgeState === "pairing" || hueBridgeState === "pairingLinkButton" ? (
                  <button type="button" className="lm-dcard-act is-danger" onClick={() => { selectBridge(null); }}>
                    {t("hue:page.cancel")}
                  </button>
                ) : hueBridgeState === "areaSelect" ? (
                  <button type="button" className="lm-dcard-act" onClick={() => { void refreshAreas(); }} disabled={hueAreasDisabled} aria-busy={isLoadingAreas}>
                    {isLoadingAreas ? t("hue:actions.loadingAreas") : t("hue:actions.refreshAreas")}
                  </button>
                ) : hueBridgeState === "authError" || hueBridgeState === "pairingFailed" ? (
                  <>
                    <button type="button" className="lm-dcard-act" onClick={() => { void pair(); }} disabled={isHuePairing} aria-busy={isHuePairing}>
                      {isHuePairing ? t("hue:actions.pairing") : t("hue:runtime.actions.repair")}
                    </button>
                    <button type="button" className="lm-dcard-act is-danger" onClick={() => { selectBridge(null); }}>
                      {t("hue:page.forgotBridge")}
                    </button>
                  </>
                ) : hueBridgeState === "offline" ? (
                  <>
                    <button type="button" className="lm-dcard-act" onClick={() => { void discover(); }} disabled={isHueDiscovering} aria-busy={isHueDiscovering}>
                      {isHueDiscovering ? t("hue:actions.discovering") : t("hue:wizard.offlineRediscover")}
                    </button>
                    <button type="button" className="lm-dcard-act" onClick={() => { setManualIp(""); }}>
                      {t("hue:page.tryDifferentIp")}
                    </button>
                    <button type="button" className="lm-dcard-act is-danger" onClick={() => { selectBridge(null); }}>
                      {t("hue:page.forgotBridge")}
                    </button>
                  </>
                ) : hueBridgeState === "reconnecting" ? (
                  <>
                    <button type="button" className="lm-dcard-act" onClick={() => { void retryRuntimeTarget(runtimeTargets[0]?.target ?? "hue"); }} disabled={isRuntimeMutating} aria-busy={isRuntimeMutating}>
                      {t("hue:page.reconnectNow")}
                    </button>
                    <button type="button" className="lm-dcard-act is-danger" onClick={() => { void stopHue(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE); }} disabled={isRuntimeMutating} aria-busy={isRuntimeMutating}>
                      {t("hue:page.stopRetrying")}
                    </button>
                  </>
                ) : hueBridgeState === "stale" ? (
                  <>
                    <button type="button" className="lm-dcard-act" onClick={() => { void revalidateArea(); }} disabled={hueReadinessDisabled} aria-busy={isCheckingReadiness}>
                      {isCheckingReadiness ? t("hue:actions.checkingReadiness") : t("hue:page.validate")}
                    </button>
                    <button type="button" className="lm-dcard-act" onClick={() => { void startRuntime(); }} disabled={hueStartDisabled}>
                      {t("hue:actions.start")}
                    </button>
                    <button type="button" className="lm-dcard-act is-danger" onClick={() => { selectBridge(null); }}>
                      {t("hue:page.forgotBridge")}
                    </button>
                  </>
                ) : hueBridgeState === "gateBlocked" ? (
                  <>
                    <button type="button" className="lm-dcard-act" onClick={() => { void revalidateArea(); }} disabled={hueReadinessDisabled} aria-busy={isCheckingReadiness}>
                      {isCheckingReadiness ? t("hue:actions.checkingReadiness") : t("hue:page.validate")}
                    </button>
                    <button type="button" className="lm-dcard-act" onClick={() => { void refreshAreas(); }} disabled={hueAreasDisabled} aria-busy={isLoadingAreas}>
                      {t("hue:page.changeArea")}
                    </button>
                  </>
                ) : hueBridgeState === "stopPartial" ? (
                  <>
                    <button type="button" className="lm-dcard-act" onClick={() => { void stopHue(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE); }} disabled={isRuntimeMutating} aria-busy={isRuntimeMutating}>
                      {t("hue:page.retryStop")}
                    </button>
                    <button type="button" className="lm-dcard-act is-danger" onClick={() => { selectBridge(null); }}>
                      {t("hue:page.forceForget")}
                    </button>
                  </>
                ) : null}
              </div>
            </div>

            {/* Channel map panel — shown when area is selected and credentials valid */}
            {selectedAreaId && credentialState === "valid" ? (
              <HueChannelMapPanel
                channels={areaChannels}
                isLoading={isLoadingChannels}
                overrides={channelRegionOverrides}
                onSetRegion={setChannelRegion}
                placements={channelPlacements}
                onPositionChange={onPositionChange}
                persistError={persistError}
                bridgeIp={selectedBridge?.ip}
                username={credentials?.username}
                areaId={selectedArea?.id}
                isStreaming={runtimeStatus?.state === "Running"}
              />
            ) : null}
          </>
        ) : null}

        {/* Manual IP form — visible when no bridge selected */}
        {!selectedBridgeId ? (
          <div className="lm-hue-ip-form">
            <div>
              <div className="lm-hue-ip-form-title">{t("hue:manualIp.title")}</div>
              <div className="lm-hue-ip-form-sub">{t("hue:manualIp.description")}</div>
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
            {manualIpError ? <div className="lm-hue-ip-error">{t(manualIpError)}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
