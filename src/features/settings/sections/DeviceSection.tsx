import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { HUE_RUNTIME_TRIGGER_SOURCE } from "../../../shared/contracts/hue";
import type { DisplayInfo } from "../../../shared/contracts/display";
import { DEFAULT_ROOM_MAP } from "../../../shared/contracts/roomMap";
import type { HueChannelPlacement, RoomMapConfig } from "../../../shared/contracts/roomMap";
import { shellStore } from "../../persistence/shellStore";
import { listDisplays } from "../../calibration/calibrationApi";
import { buildDeviceStatusCard } from "../../device/deviceStatusCard";
import { buildHueRuntimeStatusCard } from "../../device/hueRuntimeStatusCard";
import { useDeviceConnection } from "../../device/useDeviceConnection";
import { useHueOnboarding } from "../../device/useHueOnboarding";
import { stopHue } from "../../mode/modeApi";
import { HueChannelMapPanel } from "./HueChannelMapPanel";

type DeviceCategory = "usb" | "hue" | "displays" | "manual";

function portDisplayName(portName: string, product?: string, manufacturer?: string): string {
  if (product && manufacturer) {
    return `${manufacturer} ${product}`;
  }

  if (product) {
    return product;
  }

  if (manufacturer) {
    return manufacturer;
  }

  return portName;
}

/* ── Inline SVG icons ─────────────────────────────────── */

function IconCheck() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 6l3 3 5-5" />
    </svg>
  );
}


function IconInfo() {
  return (
    <svg viewBox="0 0 16 16" className="mt-0.5 h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5M8 11v.5" />
    </svg>
  );
}

function IconWifi() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 7.5a12.5 12.5 0 0116 0" />
      <path d="M5 11a8 8 0 0110 0" />
      <path d="M8 14.5a4 4 0 014 0" />
      <circle cx="10" cy="17" r="0.5" fill="currentColor" />
    </svg>
  );
}

function IconBridge() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="14" height="10" rx="3" />
      <circle cx="10" cy="10" r="2" />
      <path d="M10 5v-2M10 17v-2" />
    </svg>
  );
}

function IconUsb() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="9" width="18" height="10" rx="2" />
      <path d="M8 9V6a2 2 0 012-2h4a2 2 0 012 2v3" />
      <circle cx="12" cy="14" r="1.3" fill="currentColor" />
    </svg>
  );
}

function IconHueBridgeGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18M3 12h18" />
    </svg>
  );
}

function IconDisplayGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="13" rx="1.5" />
      <path d="M8 21h8M12 18v3" />
    </svg>
  );
}

function IconPencil() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 113 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 11-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

export function DeviceSection() {
  const { t } = useTranslation("common");
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
  } = useHueOnboarding();

  const {
    status,
    ports,
    selectedPort,
    connectedPort,
    isScanning,
    isConnecting,
    isReconnecting,
    isHealthChecking,
    isConnected,
    statusCard,
    latestHealthCheck,
    refreshPorts,
    selectPort,
    connectSelectedPort,
    runHealthCheck,
  } = useDeviceConnection();

  const statusModel = buildDeviceStatusCard({
    status,
    statusCard,
    connectedPort,
    isReconnecting,
    isHealthChecking,
    latestHealthCheck,
  });
  const statusVariant = statusModel.variant;
  const statusTitle = t(statusModel.titleKey);
  const statusBody = t(statusModel.bodyKey, {
    port: connectedPort ?? selectedPort ?? "-",
  });
  const healthStepOutcomes = statusModel.healthSteps ?? [];
  const showHealthStepOutcomes = latestHealthCheck !== null && healthStepOutcomes.length > 0;

  const healthActionDisabled = isScanning || isConnecting || isReconnecting || isHealthChecking || !selectedPort;

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

  // ── Hue bridge card state derivation ──────────────────────────────────
  const hueBridgeState = selectedBridgeId
    ? (() => {
        if (runtimeStatus?.code === "HUE_STOP_TIMEOUT_PARTIAL") return "stopPartial" as const;
        if (runtimeStatus?.code === "CONFIG_NOT_READY_GATE_BLOCKED") return "gateBlocked" as const;
        if (runtimeStatus?.state === "Running") return "streaming" as const;
        if (runtimeStatus?.state === "Reconnecting" || runtimeStatus?.code?.startsWith("TRANSIENT_")) return "reconnecting" as const;
        if (bridgeUnreachable) return "offline" as const;
        if (credentialState === "needs_repair" && !isHuePairing) {
          return hueStatus?.code === "HUE_PAIRING_FAILED" ? "pairingFailed" as const : "authError" as const;
        }
        if (isHuePairing) {
          return hueStatus?.code === "HUE_PAIRING_PENDING_LINK_BUTTON" ? "pairingLinkButton" as const : "pairing" as const;
        }
        if (credentialState === "valid") {
          if (!selectedAreaId) return "areaSelect" as const;
          if (isReadinessStale) return "stale" as const;
          return "idle" as const;
        }
        return "pairing" as const;
      })()
    : null;

  const hueIsDiscoveryFailed = !isHueDiscovering && !selectedBridgeId && hueStatus?.code === "HUE_DISCOVERY_FAILED";
  const hueIsDiscoveryEmpty = !isHueDiscovering && !selectedBridgeId && hueStatus !== null && bridges.length === 0 && !hueIsDiscoveryFailed;

  // -------------------------------------------------------------------------
  // Channel placement persistence (D-05a)
  // -------------------------------------------------------------------------

  const [channelPlacements, setChannelPlacements] = useState<HueChannelPlacement[]>([]);
  const [persistError, setPersistError] = useState(false);
  const persistErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load placements from shellStore on mount and when selectedAreaId changes
  useEffect(() => {
    let cancelled = false;
    shellStore.load().then((state) => {
      if (cancelled) return;
      setChannelPlacements(state.roomMap?.hueChannels ?? []);
    });
    return () => { cancelled = true; };
  }, [selectedAreaId]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (persistErrorTimerRef.current) clearTimeout(persistErrorTimerRef.current);
    };
  }, []);

  // -------------------------------------------------------------------------
  // Phase 7: category rail + displays list
  // -------------------------------------------------------------------------
  const [activeCategory, setActiveCategory] = useState<DeviceCategory>("usb");
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    listDisplays()
      .then((result) => {
        if (!cancelled) setDisplays(result);
      })
      .catch(() => {
        if (!cancelled) setDisplays([]);
      });
    return () => { cancelled = true; };
  }, []);

  const handlePositionChange = useCallback(async (updated: HueChannelPlacement[]) => {
    setChannelPlacements(updated);
    try {
      const current = await shellStore.load();
      const currentRoomMap = current.roomMap;
      const updatedRoomMap: RoomMapConfig = {
        ...(currentRoomMap ?? DEFAULT_ROOM_MAP),
        hueChannels: updated,
      };
      await shellStore.save({
        roomMap: updatedRoomMap,
        roomMapVersion: (current.roomMapVersion ?? 0) + 1,
      });
      setPersistError(false);
    } catch {
      setPersistError(true);
      if (persistErrorTimerRef.current) clearTimeout(persistErrorTimerRef.current);
      persistErrorTimerRef.current = setTimeout(() => { setPersistError(false); }, 3000);
    }
  }, []);

  return (
    <div className="lm-device-page">
      {/* ── Left category rail ───────────────────────────────── */}
      <nav className="lm-device-rail">
        <div className="lm-device-rail-h">{t("devicesPage.rail.connected")}</div>
        <button
          type="button"
          className={`lm-device-cat ${activeCategory === "usb" ? "is-on" : ""}`}
          onClick={() => setActiveCategory("usb")}
        >
          <span className="lm-device-cat-ic"><IconUsb /></span>
          <span className="lm-device-cat-tx">{t("devicesPage.rail.usbStrips")}</span>
          {ports.length > 0 ? <span className="lm-device-cat-cnt">{ports.length}</span> : null}
        </button>
        <button
          type="button"
          className={`lm-device-cat ${activeCategory === "hue" ? "is-on" : ""}`}
          onClick={() => setActiveCategory("hue")}
        >
          <span className="lm-device-cat-ic"><IconHueBridgeGlyph /></span>
          <span className="lm-device-cat-tx">{t("devicesPage.rail.hueBridges")}</span>
          {selectedBridge ? <span className="lm-device-cat-cnt">1</span> : null}
        </button>
        <button
          type="button"
          className={`lm-device-cat ${activeCategory === "displays" ? "is-on" : ""}`}
          onClick={() => setActiveCategory("displays")}
        >
          <span className="lm-device-cat-ic"><IconDisplayGlyph /></span>
          <span className="lm-device-cat-tx">{t("devicesPage.rail.displays")}</span>
          {displays.length > 0 ? <span className="lm-device-cat-cnt">{displays.length}</span> : null}
        </button>

        <div className="lm-device-rail-h">{t("devicesPage.rail.other")}</div>
        <button
          type="button"
          className={`lm-device-cat ${activeCategory === "manual" ? "is-on" : ""}`}
          onClick={() => setActiveCategory("manual")}
        >
          <span className="lm-device-cat-ic"><IconPencil /></span>
          <span className="lm-device-cat-tx">{t("devicesPage.rail.manualEntry")}</span>
        </button>
      </nav>

      {/* ── Main content area ────────────────────────────────── */}
      <div className="lm-device-main">
        {/* ── USB Strips category ───────────────────────────── */}
        <div className={activeCategory === "usb" ? "lm-device-cat-body" : "lm-device-cat-body hidden"} hidden={activeCategory !== "usb"}>
          <div className="lm-device-head">
            <div>
              <h1>{t("devicesPage.header.usbTitle")}</h1>
              <div className="lm-device-head-sub">
                {connectedPort
                  ? t("devicesPage.header.usbSub", { count: 1 })
                  : t("devicesPage.header.usbSubNone")}
              </div>
            </div>
            <div className="lm-device-head-actions">
              <button
                type="button"
                className="lm-device-btn"
                onClick={() => { void refreshPorts(); }}
                disabled={isScanning}
              >
                <IconRefresh />
                <span>{isScanning ? t("device.actions.scanning") : t("devicesPage.actions.rescan")}</span>
              </button>
            </div>
          </div>

          {!isConnected && (
            <p className="text-[11px] text-zinc-500">{t("device.usbDisconnected")}</p>
          )}

          <div className="lm-device-grid">
            {ports.length === 0 ? (
              <div className="lm-device-empty">
                <h3>{t("devicesPage.usb.empty.title")}</h3>
                <p>{t("devicesPage.usb.empty.body")}</p>
              </div>
            ) : (
              ports.map((port) => {
                const isConnectedCard = connectedPort === port.portName;
                const isSelectedCard = selectedPort === port.portName && !isConnectedCard;
                const pillLabel = isConnectedCard
                  ? t("devicesPage.usb.pill.online")
                  : t("devicesPage.usb.pill.discovered");
                const pillClass = isConnectedCard ? "is-ok" : "is-warn";
                const cardStateClass = isConnectedCard
                  ? "is-on"
                  : isSelectedCard
                    ? "is-sel"
                    : "is-ghost";
                return (
                  <div
                    key={port.portName}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelectedCard || isConnectedCard}
                    className={`lm-dcard ${cardStateClass}`}
                    onClick={() => {
                      if (!isConnectedCard) selectPort(port.portName);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        if (!isConnectedCard) selectPort(port.portName);
                      }
                    }}
                  >
                    <div className="lm-dcard-head">
                      <div className="lm-dcard-ic"><IconUsb /></div>
                      <div className="lm-dcard-tx">
                        <div className="lm-dcard-name">
                          <span>{portDisplayName(port.portName, port.product, port.manufacturer)}</span>
                          <span className={`lm-dcard-pill ${pillClass}`}>{pillLabel}</span>
                        </div>
                        <div className="lm-dcard-sub">{port.portName}</div>
                      </div>
                    </div>

                    <div className="lm-dcard-body">
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("devicesPage.usb.stats.ledCount")}</div>
                        <div className="lm-dcard-cell-v">{t("devicesPage.usb.stats.na")}</div>
                      </div>
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("devicesPage.usb.stats.baud")}</div>
                        <div className="lm-dcard-cell-v">115200</div>
                      </div>
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("devicesPage.usb.stats.protocol")}</div>
                        <div className="lm-dcard-cell-v">LumaSync</div>
                      </div>
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("devicesPage.usb.stats.latency")}</div>
                        <div className={`lm-dcard-cell-v ${isConnectedCard ? "is-am" : ""}`}>
                          {t("devicesPage.usb.stats.na")}
                        </div>
                      </div>
                    </div>

                    {isConnectedCard ? (
                      <div className="lm-dcard-actions">
                        <button
                          type="button"
                          className="lm-dcard-act"
                          onClick={(event) => {
                            event.stopPropagation();
                            void runHealthCheck();
                          }}
                          disabled={healthActionDisabled}
                        >
                          {isHealthChecking ? t("device.healthCheck.runningAction") : t("device.healthCheck.runAction")}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="lm-dcard-pair"
                        onClick={(event) => {
                          event.stopPropagation();
                          selectPort(port.portName);
                          void connectSelectedPort();
                        }}
                        disabled={isConnecting && isSelectedCard}
                      >
                        {isConnecting && isSelectedCard
                          ? t("device.actions.connecting")
                          : t("devicesPage.usb.pairAsStrip")}
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Status card — preserved for diagnostics & test compatibility */}
          <div
            role="status"
            aria-live="polite"
            className={`rounded-lg border p-3 ${
              statusVariant === "success"
                ? "border-emerald-500/40 bg-emerald-900/20"
                : statusVariant === "error"
                  ? "border-rose-500/40 bg-rose-900/20"
                  : "border-zinc-800 bg-zinc-800/30"
            }`}
          >
            <p className="text-[11px] font-semibold text-zinc-100">{statusTitle}</p>
            <p className="mt-0.5 text-[11px] text-zinc-300">{statusBody}</p>
            {statusModel.details ? <p className="mt-0.5 text-[10px] text-zinc-500">{statusModel.details}</p> : null}
            {showHealthStepOutcomes ? (
              <div className="mt-2 space-y-1">
                {healthStepOutcomes.map((stepOutcome) => (
                  <div key={stepOutcome.step} className="flex items-start gap-2 rounded border border-zinc-700 bg-zinc-900/30 px-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] font-medium text-zinc-100">
                        {t(`device.healthCheck.steps.labels.${stepOutcome.step}`)}
                      </p>
                      <p className="mt-0.5 text-[10px] text-zinc-400">{stepOutcome.message}</p>
                      {stepOutcome.details ? <p className="mt-0.5 text-[10px] text-zinc-500">{stepOutcome.details}</p> : null}
                    </div>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                        stepOutcome.pass
                          ? "bg-emerald-500/20 text-emerald-300"
                          : "bg-rose-500/20 text-rose-300"
                      }`}
                    >
                      {stepOutcome.pass ? t("device.healthCheck.steps.outcome.pass") : t("device.healthCheck.steps.outcome.fail")}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {statusCard?.code === "SELECTED_PORT_MISSING" ? (
              <p className="mt-1 text-[10px] text-zinc-500">
                {t("device.port.missingHint", { port: selectedPort ?? "-" })}
              </p>
            ) : null}
          </div>

        </div>

        {/* ── Hue Bridges category ───────────────────────────── */}
        <div className={activeCategory === "hue" ? "lm-device-cat-body" : "lm-device-cat-body hidden"} hidden={activeCategory !== "hue"}>
          <div className="lm-device-head">
            <div>
              <h1>{t("devicesPage.header.hueTitle")}</h1>
              <div className="lm-device-head-sub" role="status" aria-live="polite">
                {hueBridgeState === "streaming"
                  ? t("device.hue.card.subtitleStreaming", { area: selectedArea?.name ?? "—" })
                  : hueBridgeState === "idle"
                  ? `${selectedArea?.name ?? "—"} · ${t("devicesPage.hue.pill.ready").toLowerCase()}`
                  : hueBridgeState === "pairing" || hueBridgeState === "pairingLinkButton"
                  ? t("device.hue.wizard.pairingStep")
                  : hueBridgeState === "areaSelect"
                  ? t("device.hue.wizard.areaStep")
                  : hueBridgeState === "authError"
                  ? t("device.hue.credential.needsRepair")
                  : hueBridgeState === "pairingFailed"
                  ? t("device.hue.wizard.pairingFailed")
                  : hueBridgeState === "offline"
                  ? t("device.hue.bridge.unreachable")
                  : hueBridgeState === "reconnecting"
                  ? t("device.hue.runtime.reconnectingTitle")
                  : hueBridgeState === "stale"
                  ? t("device.hue.runtime.checklist.revalidate")
                  : hueBridgeState === "gateBlocked"
                  ? t("device.hue.runtime.checklist.title")
                  : hueBridgeState === "stopPartial"
                  ? t("device.hue.runtime.timeout.title")
                  : t("devicesPage.header.hueSub")}
              </div>
            </div>
            <div className="lm-device-head-actions">
              <button
                type="button"
                className="lm-device-btn"
                onClick={() => { void discover(); }}
                disabled={isHueDiscovering}
              >
                <IconRefresh />
                <span>{isHueDiscovering ? t("devicesPage.hue.scanning") : hueBridgeState === "offline" ? t("device.hue.wizard.offlineRediscover") : t("devicesPage.hue.scanNetwork")}</span>
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
                    {t("devicesPage.hue.scanningDetail")}
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
                            <span className="lm-dcard-pill is-warn">{t("devicesPage.hue.pill.discovered")}</span>
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
                          {t("devicesPage.hue.addBridge")}
                        </button>
                      </div>
                    </div>
                  ))}
                </>
              ) : hueIsDiscoveryFailed ? (
                /* State K2: Discovery failed */
                <div className="lm-hue-hero">
                  <div className="lm-hue-hero-ic"><IconWifi /></div>
                  <p className="lm-hue-hero-title">{t("devicesPage.hue.scanFailed")}</p>
                  <p className="lm-hue-hero-sub">{t("devicesPage.hue.scanFailedBody")}</p>
                  <div className="lm-hue-hero-btns">
                    <button type="button" className="lm-dcard-act" onClick={() => { void discover(); }}>
                      {t("devicesPage.hue.scanAgain")}
                    </button>
                  </div>
                </div>
              ) : hueIsDiscoveryEmpty ? (
                /* State K1: Discovery empty */
                <div className="lm-hue-hero">
                  <div className="lm-hue-hero-ic"><IconBridge /></div>
                  <p className="lm-hue-hero-title">{t("devicesPage.hue.noResult")}</p>
                  <p className="lm-hue-hero-sub">{t("devicesPage.hue.noResultBody")}</p>
                  <div className="lm-hue-hero-btns">
                    <button type="button" className="lm-dcard-act" onClick={() => { void discover(); }}>
                      {t("devicesPage.hue.scanAgain")}
                    </button>
                  </div>
                </div>
              ) : (
                /* State I: Empty hero — initial state */
                <div className="lm-hue-hero">
                  <div className="lm-hue-hero-ic"><IconBridge /></div>
                  <p className="lm-hue-hero-title">{t("device.hue.wizard.emptyTitle")}</p>
                  <p className="lm-hue-hero-sub">{t("device.hue.wizard.emptyBody")}</p>
                  <div className="lm-hue-hero-btns">
                    <button type="button" className="lm-dcard-act" onClick={() => { void discover(); }}>
                      {t("device.hue.wizard.emptyAction")}
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
                          {hueBridgeState === "streaming" ? t("devicesPage.hue.pill.streaming") :
                           hueBridgeState === "idle" ? t("devicesPage.hue.pill.ready") :
                           hueBridgeState === "pairing" || hueBridgeState === "pairingLinkButton" ? t("devicesPage.hue.pill.awaiting") :
                           hueBridgeState === "pairingFailed" ? t("devicesPage.hue.pill.failed") :
                           hueBridgeState === "areaSelect" ? t("devicesPage.hue.pill.paired") :
                           hueBridgeState === "authError" ? t("devicesPage.hue.pill.authError") :
                           hueBridgeState === "offline" ? t("device.hue.bridge.unreachable") :
                           hueBridgeState === "reconnecting" ? t("devicesPage.hue.pill.reconnecting") :
                           hueBridgeState === "stale" || hueBridgeState === "gateBlocked" ? t("devicesPage.hue.pill.awaiting") :
                           hueBridgeState === "stopPartial" ? t("devicesPage.hue.pill.failed") :
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
                        <span>{t("device.hue.card.trafficLabel")}</span>
                        <b>DTLS · 20 Hz</b>
                      </div>
                    </div>
                  ) : null}

                  {/* State E: Auth error repair banner — shown BEFORE data cells */}
                  {hueBridgeState === "authError" ? (
                    <div className="lm-hue-repair is-error">
                      <IconInfo />
                      <div className="lm-hue-repair-tx">
                        <div className="lm-hue-repair-title">{t("device.hue.credential.needsRepair")}</div>
                        <div className="lm-hue-repair-sub">{t("device.hue.credential.repairHint")}</div>
                      </div>
                      <button
                        type="button"
                        className="lm-hue-repair-act"
                        onClick={() => { void pair(); }}
                        disabled={isHuePairing}
                      >
                        {isHuePairing ? t("device.hue.actions.pairing") : t("device.hue.runtime.actions.repair")}
                      </button>
                    </div>
                  ) : null}

                  {/* Stats body — state-specific 4-cell layout */}
                  {hueBridgeState === "streaming" ? (
                    <div className="lm-dcard-body">
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("device.hue.card.cellArea")}</div>
                        <div className="lm-dcard-cell-v is-am">{selectedArea?.name ?? "—"}</div>
                      </div>
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("device.hue.card.cellProtocol")}</div>
                        <div className="lm-dcard-cell-v is-dim">DTLS</div>
                      </div>
                      {selectedArea?.channelCount !== undefined ? (
                        <div className="lm-dcard-cell">
                          <div className="lm-dcard-cell-k">{t("device.hue.card.cellCh")}</div>
                          <div className="lm-dcard-cell-v">{selectedArea.channelCount}</div>
                        </div>
                      ) : null}
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("device.hue.card.cellRate")}</div>
                        <div className="lm-dcard-cell-v is-am">20 Hz</div>
                      </div>
                    </div>
                  ) : hueBridgeState === "idle" ? (
                    <div className="lm-dcard-body">
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("device.hue.card.cellArea")}</div>
                        <div className="lm-dcard-cell-v">{selectedArea?.name ?? "—"}</div>
                      </div>
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("device.hue.card.cellProtocol")}</div>
                        <div className="lm-dcard-cell-v is-dim">DTLS</div>
                      </div>
                      {selectedArea?.channelCount !== undefined ? (
                        <div className="lm-dcard-cell">
                          <div className="lm-dcard-cell-k">{t("device.hue.card.cellCh")}</div>
                          <div className="lm-dcard-cell-v">{selectedArea.channelCount}</div>
                        </div>
                      ) : null}
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("device.hue.card.cellStatus")}</div>
                        <div className="lm-dcard-cell-v is-ok">{t("devicesPage.hue.pill.ready")}</div>
                      </div>
                    </div>
                  ) : hueBridgeState === "stale" ? (
                    <div className="lm-dcard-body">
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("device.hue.card.cellArea")}</div>
                        <div className="lm-dcard-cell-v">{selectedArea?.name ?? "—"}</div>
                      </div>
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("device.hue.card.cellProtocol")}</div>
                        <div className="lm-dcard-cell-v is-dim">DTLS</div>
                      </div>
                      {selectedArea?.channelCount !== undefined ? (
                        <div className="lm-dcard-cell">
                          <div className="lm-dcard-cell-k">{t("device.hue.card.cellCh")}</div>
                          <div className="lm-dcard-cell-v">{selectedArea.channelCount}</div>
                        </div>
                      ) : null}
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("device.hue.card.cellStatus")}</div>
                        <div className="lm-dcard-cell-v is-warn">{t("devicesPage.hue.pill.awaiting")}</div>
                      </div>
                    </div>
                  ) : hueBridgeState === "reconnecting" ? (
                    <div className="lm-dcard-body">
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("device.hue.card.cellArea")}</div>
                        <div className="lm-dcard-cell-v is-dim">{selectedArea?.name ?? "—"}</div>
                      </div>
                      {hueStatus?.code ? (
                        <div className="lm-dcard-cell">
                          <div className="lm-dcard-cell-k">{t("device.hue.card.cellError")}</div>
                          <div className="lm-dcard-cell-v is-error" style={{ fontSize: "9px" }}>{hueStatus.code}</div>
                        </div>
                      ) : null}
                      {hueRuntimeModel.retry?.remainingAttempts !== undefined ? (
                        <div className="lm-dcard-cell">
                          <div className="lm-dcard-cell-k">{t("device.hue.card.cellRetries")}</div>
                          <div className="lm-dcard-cell-v is-am">{hueRuntimeModel.retry.remainingAttempts}</div>
                        </div>
                      ) : null}
                      {hueRuntimeModel.retry?.nextAttemptMs !== undefined ? (
                        <div className="lm-dcard-cell">
                          <div className="lm-dcard-cell-k">{t("device.hue.card.cellNext")}</div>
                          <div className="lm-dcard-cell-v is-am">{(hueRuntimeModel.retry.nextAttemptMs / 1000).toFixed(1)} s</div>
                        </div>
                      ) : null}
                    </div>
                  ) : hueBridgeState === "stopPartial" ? (
                    <div className="lm-dcard-body">
                      {selectedArea ? (
                        <div className="lm-dcard-cell">
                          <div className="lm-dcard-cell-k">{t("device.hue.card.cellArea")}</div>
                          <div className="lm-dcard-cell-v is-dim">{selectedArea.name}</div>
                        </div>
                      ) : null}
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("device.hue.card.cellFault")}</div>
                        <div className="lm-dcard-cell-v is-am" style={{ fontSize: "9px" }}>HUE_STOP_PARTIAL</div>
                      </div>
                    </div>
                  ) : hueBridgeState === "gateBlocked" ? (
                    <div className="lm-dcard-body">
                      {selectedArea ? (
                        <div className="lm-dcard-cell">
                          <div className="lm-dcard-cell-k">{t("device.hue.card.cellArea")}</div>
                          <div className="lm-dcard-cell-v is-dim">{selectedArea.name}</div>
                        </div>
                      ) : null}
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("device.hue.card.cellProtocol")}</div>
                        <div className="lm-dcard-cell-v is-dim">DTLS</div>
                      </div>
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("device.hue.card.cellConfig")}</div>
                        <div className="lm-dcard-cell-v is-error" style={{ fontSize: "9px" }}>NOT_READY</div>
                      </div>
                    </div>
                  ) : hueBridgeState === "authError" ? (
                    <div className="lm-dcard-body">
                      {selectedArea ? (
                        <div className="lm-dcard-cell">
                          <div className="lm-dcard-cell-k">{t("device.hue.card.cellArea")}</div>
                          <div className="lm-dcard-cell-v is-dim">{selectedArea.name}</div>
                        </div>
                      ) : null}
                      <div className="lm-dcard-cell">
                        <div className="lm-dcard-cell-k">{t("device.hue.card.cellCredential")}</div>
                        <div className="lm-dcard-cell-v is-error">{t("device.hue.card.cellCredentialInvalid")}</div>
                      </div>
                      {hueStatus?.code ? (
                        <div className="lm-dcard-cell">
                          <div className="lm-dcard-cell-k">{t("device.hue.card.cellFault")}</div>
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
                        <span>{t("device.hue.steps.discover")}</span>
                      </div>
                      <div className="lm-hue-step-line is-done" />
                      <div className="lm-hue-step is-active">
                        <span className="lm-hue-step-dot" />
                        <span>{t("device.hue.steps.pair")}</span>
                      </div>
                      <div className="lm-hue-step-line" />
                      <div className="lm-hue-step">
                        <span className="lm-hue-step-dot" />
                        <span>{t("device.hue.steps.area")}</span>
                      </div>
                      <div className="lm-hue-step-line" />
                      <div className="lm-hue-step">
                        <span className="lm-hue-step-dot" />
                        <span>{t("device.hue.steps.ready")}</span>
                      </div>
                    </div>
                  ) : hueBridgeState === "pairingFailed" ? (
                    <div className="lm-hue-steps">
                      <div className="lm-hue-step is-done">
                        <span className="lm-hue-step-dot"><IconCheck /></span>
                        <span>{t("device.hue.steps.discover")}</span>
                      </div>
                      <div className="lm-hue-step-line is-done" />
                      <div className="lm-hue-step is-fail">
                        <span className="lm-hue-step-dot" />
                        <span>{t("device.hue.steps.pair")}</span>
                      </div>
                      <div className="lm-hue-step-line" />
                      <div className="lm-hue-step">
                        <span className="lm-hue-step-dot" />
                        <span>{t("device.hue.steps.area")}</span>
                      </div>
                      <div className="lm-hue-step-line" />
                      <div className="lm-hue-step">
                        <span className="lm-hue-step-dot" />
                        <span>{t("device.hue.steps.ready")}</span>
                      </div>
                    </div>
                  ) : null}

                  {/* State C: Link button wait */}
                  {hueBridgeState === "pairingLinkButton" ? (
                    <div className="lm-hue-wait">
                      <span className="lm-hue-wait-sp" />
                      <span>{t("device.hue.pair.linkButtonHint")}</span>
                    </div>
                  ) : null}

                  {/* State D/G: Area selection */}
                  {hueBridgeState === "areaSelect" ? (
                    <div className="lm-hue-areas">
                      <div className="lm-hue-areas-label">{t("device.hue.areas.selectLabel")}</div>
                      {areaGroups.length === 0 ? (
                        <p style={{ fontFamily: "var(--lm-mono)", fontSize: "10px", color: "var(--lm-ink-faint)", padding: "4px 0" }}>
                          {t("device.hue.areas.empty")}
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
                                <span className="lm-hue-area-ch">{t("device.hue.areas.channels", { count: area.channelCount ?? 0 })}</span>
                                {area.activeStreamer ? (
                                  <span className="lm-hue-area-badge">{t("device.hue.areas.activeStreamer")}</span>
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
                            <div className="lm-hue-repair-title">{t("device.hue.areas.conflictTitle")}</div>
                            <div className="lm-hue-repair-sub">{t("device.hue.areas.conflictHint")}</div>
                          </div>
                        </div>
                      ) : null}
                      {selectedAreaId ? (
                        <button
                          type="button"
                          className="lm-hue-area-confirm"
                          onClick={() => { void revalidateArea(); }}
                          disabled={hueReadinessDisabled}
                        >
                          {isCheckingReadiness ? t("device.hue.actions.checkingReadiness") : `${t("devicesPage.hue.confirmArea")} →`}
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  {/* State F: Offline reasons */}
                  {hueBridgeState === "offline" ? (
                    <div className="lm-hue-offline">
                      <div className="lm-hue-offline-title">{t("device.hue.wizard.offlineReasonsTitle")}</div>
                      <div className="lm-hue-offline-item">{t("device.hue.wizard.offlineReason1")}</div>
                      <div className="lm-hue-offline-item">{t("device.hue.wizard.offlineReason2")}</div>
                      <div className="lm-hue-offline-item">{t("device.hue.wizard.offlineReason3")}</div>
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
                          : t("device.hue.runtime.reconnectingTitle")}
                      </span>
                      <button
                        type="button"
                        className="lm-hue-retry-cancel"
                        onClick={() => { void stopHue(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE); }}
                        disabled={isRuntimeMutating}
                      >
                        {t("devicesPage.hue.stopRetrying")}
                      </button>
                    </div>
                  ) : null}

                  {/* State N: Stale readiness */}
                  {hueBridgeState === "stale" ? (
                    <div className="lm-hue-stale">
                      <IconInfo />
                      <span className="lm-hue-stale-tx">{t("device.hue.runtime.checklist.revalidate")}</span>
                      <button
                        type="button"
                        className="lm-hue-stale-act"
                        onClick={() => { void revalidateArea(); }}
                        disabled={hueReadinessDisabled}
                      >
                        {isCheckingReadiness ? t("device.hue.actions.checkingReadiness") : t("devicesPage.hue.validate")}
                      </button>
                    </div>
                  ) : null}

                  {/* State P: Gate blocked checklist */}
                  {hueBridgeState === "gateBlocked" ? (
                    <div className="lm-hue-checklist">
                      <div className="lm-hue-checklist-title">{t("device.hue.runtime.checklist.title")}</div>
                      {isReadinessStale ? (
                        <div className="lm-hue-checklist-item">
                          <IconInfo />
                          <span>{t("device.hue.runtime.checklist.revalidate")}</span>
                        </div>
                      ) : null}
                      <div className="lm-hue-checklist-btns">
                        <button
                          type="button"
                          className="lm-hue-checklist-btn"
                          onClick={() => { void revalidateArea(); }}
                          disabled={hueReadinessDisabled}
                        >
                          {isCheckingReadiness ? t("device.hue.actions.checkingReadiness") : t("devicesPage.hue.validate")}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {/* State Q: Stop timeout fault */}
                  {hueBridgeState === "stopPartial" ? (
                    <div className="lm-hue-fault">
                      {t("device.hue.runtime.timeout.title")}
                    </div>
                  ) : null}

                  {/* ── Action buttons footer ── */}
                  <div className="lm-dcard-actions">
                    {hueBridgeState === "streaming" ? (
                      <>
                        <button type="button" className="lm-dcard-act" onClick={() => { void refreshAreas(); }} disabled={hueAreasDisabled}>
                          {t("devicesPage.hue.changeArea")}
                        </button>
                        <button type="button" className="lm-dcard-act" onClick={() => { void startRuntime(); }} disabled={isRuntimeMutating || hueStartDisabled}>
                          {t("devicesPage.hue.reconnectNow")}
                        </button>
                        <button type="button" className="lm-dcard-act is-danger" onClick={() => { selectBridge(null); }}>
                          {t("devicesPage.hue.forgotBridge")}
                        </button>
                      </>
                    ) : hueBridgeState === "idle" ? (
                      <>
                        <button type="button" className="lm-dcard-act" onClick={() => { void refreshAreas(); }} disabled={hueAreasDisabled}>
                          {t("devicesPage.hue.changeArea")}
                        </button>
                        <button type="button" className="lm-dcard-act" onClick={() => { void revalidateArea(); }} disabled={hueReadinessDisabled}>
                          {isCheckingReadiness ? t("device.hue.actions.checkingReadiness") : t("devicesPage.hue.validate")}
                        </button>
                        <button type="button" className="lm-dcard-act is-danger" onClick={() => { selectBridge(null); }}>
                          {t("devicesPage.hue.forgotBridge")}
                        </button>
                      </>
                    ) : hueBridgeState === "pairing" || hueBridgeState === "pairingLinkButton" ? (
                      <button type="button" className="lm-dcard-act is-danger" onClick={() => { selectBridge(null); }}>
                        {t("devicesPage.hue.cancel")}
                      </button>
                    ) : hueBridgeState === "areaSelect" ? (
                      <button type="button" className="lm-dcard-act" onClick={() => { void refreshAreas(); }} disabled={hueAreasDisabled}>
                        {isLoadingAreas ? t("device.hue.actions.loadingAreas") : t("device.hue.actions.refreshAreas")}
                      </button>
                    ) : hueBridgeState === "authError" || hueBridgeState === "pairingFailed" ? (
                      <>
                        <button type="button" className="lm-dcard-act" onClick={() => { void pair(); }} disabled={isHuePairing}>
                          {isHuePairing ? t("device.hue.actions.pairing") : t("device.hue.runtime.actions.repair")}
                        </button>
                        <button type="button" className="lm-dcard-act is-danger" onClick={() => { selectBridge(null); }}>
                          {t("devicesPage.hue.forgotBridge")}
                        </button>
                      </>
                    ) : hueBridgeState === "offline" ? (
                      <>
                        <button type="button" className="lm-dcard-act" onClick={() => { void discover(); }} disabled={isHueDiscovering}>
                          {isHueDiscovering ? t("device.hue.actions.discovering") : t("device.hue.wizard.offlineRediscover")}
                        </button>
                        <button type="button" className="lm-dcard-act" onClick={() => { setManualIp(""); }}>
                          {t("devicesPage.hue.tryDifferentIp")}
                        </button>
                        <button type="button" className="lm-dcard-act is-danger" onClick={() => { selectBridge(null); }}>
                          {t("devicesPage.hue.forgotBridge")}
                        </button>
                      </>
                    ) : hueBridgeState === "reconnecting" ? (
                      <>
                        <button type="button" className="lm-dcard-act" onClick={() => { void retryRuntimeTarget(runtimeTargets[0]?.target ?? "hue"); }} disabled={isRuntimeMutating}>
                          {t("devicesPage.hue.reconnectNow")}
                        </button>
                        <button type="button" className="lm-dcard-act is-danger" onClick={() => { void stopHue(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE); }} disabled={isRuntimeMutating}>
                          {t("devicesPage.hue.stopRetrying")}
                        </button>
                      </>
                    ) : hueBridgeState === "stale" ? (
                      <>
                        <button type="button" className="lm-dcard-act" onClick={() => { void revalidateArea(); }} disabled={hueReadinessDisabled}>
                          {isCheckingReadiness ? t("device.hue.actions.checkingReadiness") : t("devicesPage.hue.validate")}
                        </button>
                        <button type="button" className="lm-dcard-act" onClick={() => { void startRuntime(); }} disabled={hueStartDisabled}>
                          {t("device.hue.actions.start")}
                        </button>
                        <button type="button" className="lm-dcard-act is-danger" onClick={() => { selectBridge(null); }}>
                          {t("devicesPage.hue.forgotBridge")}
                        </button>
                      </>
                    ) : hueBridgeState === "gateBlocked" ? (
                      <>
                        <button type="button" className="lm-dcard-act" onClick={() => { void revalidateArea(); }} disabled={hueReadinessDisabled}>
                          {isCheckingReadiness ? t("device.hue.actions.checkingReadiness") : t("devicesPage.hue.validate")}
                        </button>
                        <button type="button" className="lm-dcard-act" onClick={() => { void refreshAreas(); }} disabled={hueAreasDisabled}>
                          {t("devicesPage.hue.changeArea")}
                        </button>
                      </>
                    ) : hueBridgeState === "stopPartial" ? (
                      <>
                        <button type="button" className="lm-dcard-act" onClick={() => { void stopHue(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE); }} disabled={isRuntimeMutating}>
                          {t("devicesPage.hue.retryStop")}
                        </button>
                        <button type="button" className="lm-dcard-act is-danger" onClick={() => { selectBridge(null); }}>
                          {t("devicesPage.hue.forceForget")}
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
                    onPositionChange={handlePositionChange}
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
                  <div className="lm-hue-ip-form-title">{t("device.hue.manualIp.title")}</div>
                  <div className="lm-hue-ip-form-sub">{t("device.hue.manualIp.description")}</div>
                </div>
                <div className="lm-hue-ip-row">
                  <input
                    className="lm-hue-ip-input"
                    value={manualIp}
                    onChange={(e) => { setManualIp(e.target.value); }}
                    placeholder={t("device.hue.manualIp.placeholder")}
                  />
                  <button
                    type="button"
                    className="lm-hue-ip-submit"
                    onClick={() => { void submitManualIp(); }}
                    disabled={hueManualIpDisabled}
                  >
                    {t("devicesPage.hue.enterIp")}
                  </button>
                </div>
                {manualIpError ? <div className="lm-hue-ip-error">{t(manualIpError)}</div> : null}
              </div>
            ) : null}
          </div>
        </div>


        {/* ── Displays category ──────────────────────────────── */}
        <div className={activeCategory === "displays" ? "lm-device-cat-body" : "lm-device-cat-body hidden"} hidden={activeCategory !== "displays"}>
          <div className="lm-device-head">
            <div>
              <h1>{t("devicesPage.header.displaysTitle")}</h1>
              <div className="lm-device-head-sub">{t("devicesPage.header.displaysSub")}</div>
            </div>
          </div>
          <div className="lm-device-grid">
            {displays.length === 0 ? (
              <div className="lm-device-empty">
                <p>{t("devicesPage.displays.empty")}</p>
              </div>
            ) : (
              displays.map((display) => (
                <div key={display.id} className="lm-dcard is-ghost">
                  <div className="lm-dcard-head">
                    <div className="lm-dcard-ic"><IconDisplayGlyph /></div>
                    <div className="lm-dcard-tx">
                      <div className="lm-dcard-name">
                        <span>{display.label}</span>
                        {display.isPrimary ? (
                          <span className="lm-dcard-pill is-ok">{t("devicesPage.displays.primary")}</span>
                        ) : null}
                      </div>
                      <div className="lm-dcard-sub">{`${display.width} × ${display.height}`}</div>
                    </div>
                  </div>
                  <div className="lm-dcard-body">
                    <div className="lm-dcard-cell">
                      <div className="lm-dcard-cell-k">{t("devicesPage.displays.cellId")}</div>
                      <div className="lm-dcard-cell-v">{display.id}</div>
                    </div>
                    <div className="lm-dcard-cell">
                      <div className="lm-dcard-cell-k">{t("devicesPage.displays.cellScale")}</div>
                      <div className="lm-dcard-cell-v">{(display.scaleFactor ?? 1).toFixed(1)}x</div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Manual Entry category ──────────────────────────── */}
        <div className={activeCategory === "manual" ? "lm-device-cat-body" : "lm-device-cat-body hidden"} hidden={activeCategory !== "manual"}>
          <div className="lm-device-head">
            <div>
              <h1>{t("devicesPage.header.manualTitle")}</h1>
              <div className="lm-device-head-sub">{t("devicesPage.header.manualSub")}</div>
            </div>
          </div>
          <div className="lm-device-empty">
            <p>{t("devicesPage.manual.body")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
