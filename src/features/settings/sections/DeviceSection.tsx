import { useState } from "react";
import { useTranslation } from "react-i18next";

import { HUE_RUNTIME_TRIGGER_SOURCE } from "../../../shared/contracts/hue";
import { buildDeviceStatusCard } from "../../device/deviceStatusCard";
import { buildHueRuntimeStatusCard } from "../../device/hueRuntimeStatusCard";
import { buildHueStatusCard } from "../../device/hueStatusCard";
import { useDeviceConnection } from "../../device/useDeviceConnection";
import { useHueOnboarding } from "../../device/useHueOnboarding";
import { stopHue } from "../../mode/modeApi";
import { HueChannelMapPanel, MiniSpatialPreview } from "./HueChannelMapPanel";

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

const HUE_STEPS = ["discover", "pair", "area", "ready"] as const;
type HueStepKey = (typeof HUE_STEPS)[number];

/* ── Inline SVG icons ─────────────────────────────────── */

function IconCheck() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 6l3 3 5-5" />
    </svg>
  );
}

function IconChevronDown({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6l4 4 4-4" />
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

export function DeviceSection() {
  const { t } = useTranslation("common");
  const {
    step: hueStep,
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
    groupedPorts,
    ports,
    selectedPort,
    connectedPort,
    isScanning,
    isConnecting,
    isReconnecting,
    isHealthChecking,
    canConnect,
    statusCard,
    latestHealthCheck,
    refreshPorts,
    selectPort,
    connectSelectedPort,
    runHealthCheck,
    connectButtonLabel,
  } = useDeviceConnection();

  const selected = ports.find((port) => port.portName === selectedPort) ?? null;

  const connectLabelKey =
    connectButtonLabel === "connected"
      ? "device.actions.connected"
      : connectButtonLabel === "reconnect"
        ? "device.actions.reconnect"
        : "device.actions.connect";

  const connectDisabled =
    !canConnect || isScanning || (connectButtonLabel === "connected" && connectedPort === selectedPort);

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
  const huePairDisabled = isHuePairing || !selectedBridge;
  const hueAreasDisabled = !selectedBridge || credentialState !== "valid" || isLoadingAreas;
  const hueReadinessDisabled = !selectedBridge || !selectedAreaId || credentialState !== "valid" || isCheckingReadiness;
  const hueStartDisabled =
    !canStartHue
    || isValidatingCredential
    || credentialState !== "valid"
    || isReadinessStale
    || isRuntimeMutating;

  // When bridge is unreachable due to network, visually keep focus on Discover step
  // so the user understands the action is "get on the right network", not "re-pair".
  const visualActiveStep = bridgeUnreachable ? "discover" : hueStep;

  const hueStatusModel = buildHueStatusCard({
    status: hueStatus,
    credentialState,
    isValidatingCredential,
    isPairing: isHuePairing,
    isCheckingReadiness,
    bridgeUnreachable,
  });

  const hueRuntimeModel = buildHueRuntimeStatusCard({
    status: runtimeStatus,
  });

  const showRuntimeChecklist = isValidatingCredential || credentialState === "unknown" || isReadinessStale;

  const hueStepStates: Record<HueStepKey, boolean> = {
    discover: selectedBridgeId !== null,
    pair: credentialState === "valid",
    area: Boolean(selectedAreaId),
    ready: canStartHue,
  };

  // Wizard accordion: user can click completed steps to revisit them
  const [hueExpandedStep, setHueExpandedStep] = useState<HueStepKey | null>(null);
  // Derive which step should be open: user override > active step
  const resolvedExpandedStep = hueExpandedStep ?? visualActiveStep;

  // Header badge for Hue section
  const hueHeaderBadge = (() => {
    if (isValidatingCredential) {
      return {
        label: t("device.hue.bridge.checking"),
        className: "bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-300",
      };
    }
    if (bridgeUnreachable) {
      return {
        label: t("device.hue.wizard.badgeUnreachable"),
        className: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
      };
    }
    if (canStartHue) {
      return {
        label: t("device.hue.wizard.badgeReady"),
        className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
      };
    }
    if (credentialState === "valid") {
      return {
        label: t("device.hue.wizard.badgeConnected"),
        className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
      };
    }
    if (selectedBridgeId) {
      return {
        label: t("device.hue.wizard.badgeInProgress"),
        className: "bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-300",
      };
    }
    return {
      label: t("device.hue.wizard.badgeNotStarted"),
      className: "bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-500",
    };
  })();

  const renderPortRows = (kind: "supported" | "other") => {
    const list = kind === "supported" ? groupedPorts.supported : groupedPorts.other;

    if (list.length === 0) {
      return (
        <li className="rounded-xl border border-dashed border-slate-200 px-3 py-2.5 text-xs text-slate-400 dark:border-zinc-700 dark:text-zinc-500">
          {t("device.groups.empty")}
        </li>
      );
    }

    return list.map((port) => {
      const active = selectedPort === port.portName;
      const isConnectedPort = connectedPort === port.portName;

      // State-aware connection badge — mirrors Hue bridge reachability badge
      let connBadgeLabel: string | null = null;
      let connBadgeActiveClass = "";
      let connBadgeInactiveClass = "";

      if (isConnectedPort) {
        if (isReconnecting) {
          connBadgeLabel = t("device.badges.reconnecting");
          connBadgeActiveClass = "bg-amber-400/20 text-amber-100 dark:bg-amber-500/20 dark:text-amber-800";
          connBadgeInactiveClass = "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300";
        } else if (isHealthChecking) {
          connBadgeLabel = t("device.badges.checking");
          connBadgeActiveClass = "bg-white/15 text-white/80 dark:bg-zinc-700/25 dark:text-zinc-600";
          connBadgeInactiveClass = "bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400";
        } else if (status === "error" || status === "manual_required") {
          connBadgeLabel = t("device.badges.error");
          connBadgeActiveClass = "bg-rose-400/20 text-rose-100 dark:bg-rose-500/20 dark:text-rose-800";
          connBadgeInactiveClass = "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300";
        } else {
          connBadgeLabel = t("device.badges.connected");
          connBadgeActiveClass = "bg-white/20 text-white dark:bg-emerald-500/15 dark:text-emerald-400";
          connBadgeInactiveClass = "bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-300";
        }
      }

      return (
        <li key={port.portName}>
          <button
            type="button"
            onClick={() => {
              selectPort(port.portName);
            }}
            className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${
              active
                ? "border-slate-900 bg-slate-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                : "border-slate-200 bg-white text-slate-800 hover:border-slate-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-500"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">
                  {portDisplayName(port.portName, port.product, port.manufacturer)}
                </p>
                <p className={`mt-0.5 font-mono truncate text-[11px] ${active ? "text-white/70 dark:text-zinc-600" : "text-slate-400 dark:text-zinc-500"}`}>
                  {port.portName}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    port.isSupported
                      ? active
                        ? "bg-emerald-400/20 text-emerald-100 dark:bg-emerald-500/20 dark:text-emerald-400"
                        : "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                      : active
                        ? "bg-amber-400/20 text-amber-100 dark:bg-amber-400/20 dark:text-amber-300"
                        : "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
                  }`}
                >
                  {port.isSupported ? t("device.badges.supported") : t("device.badges.other")}
                </span>

                {connBadgeLabel ? (
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${active ? connBadgeActiveClass : connBadgeInactiveClass}`}>
                    {connBadgeLabel}
                  </span>
                ) : null}
              </div>
            </div>
          </button>
        </li>
      );
    });
  };

  /* ── Wizard step header row helper ──────────────────── */
  function renderWizardStepHeader(
    stepKey: HueStepKey,
    stepIndex: number,
    isCompleted: boolean,
    isActive: boolean,
    isLocked: boolean,
    summaryText?: string,
  ) {
    const isExpanded = resolvedExpandedStep === stepKey;
    const canClick = isCompleted || isActive;

    return (
      <button
        type="button"
        onClick={() => {
          if (canClick) {
            setHueExpandedStep(isExpanded ? null : stepKey);
          }
        }}
        disabled={isLocked}
        aria-expanded={isExpanded}
        className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
          canClick && !isLocked
            ? "hover:bg-slate-50 dark:hover:bg-zinc-800/50"
            : ""
        } ${isLocked ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
      >
        {/* Step circle */}
        <div
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition-colors ${
            isCompleted
              ? "bg-emerald-500 text-white"
              : isActive
                ? "bg-slate-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "bg-slate-100 text-slate-400 dark:bg-zinc-800 dark:text-zinc-500"
          }`}
        >
          {isCompleted ? <IconCheck /> : String(stepIndex + 1)}
        </div>

        {/* Label + summary */}
        <div className="min-w-0 flex-1">
          <span
            className={`text-xs font-semibold ${
              isActive
                ? "text-slate-900 dark:text-zinc-100"
                : isCompleted
                  ? "text-slate-700 dark:text-zinc-300"
                  : "text-slate-400 dark:text-zinc-500"
            }`}
          >
            {t(`device.hue.steps.${stepKey}`)}
          </span>
          {isCompleted && summaryText && !isExpanded ? (
            <span className="ml-2 text-[11px] text-slate-400 dark:text-zinc-500">
              {summaryText}
            </span>
          ) : null}
          {isLocked ? (
            <span className="ml-2 text-[11px] text-slate-400 dark:text-zinc-500">
              {t("device.hue.wizard.locked")}
            </span>
          ) : null}
        </div>

        {/* Expand indicator */}
        {canClick && !isLocked ? (
          <IconChevronDown open={isExpanded} />
        ) : null}
      </button>
    );
  }

  /* ── Step content visibility ─────────────────────────── */
  const stepOrder: HueStepKey[] = ["discover", "pair", "area", "ready"];

  function isStepLocked(stepKey: HueStepKey): boolean {
    const idx = stepOrder.indexOf(stepKey);
    // A step is locked if all prior steps are not completed
    for (let i = 0; i < idx; i++) {
      if (!hueStepStates[stepOrder[i]]) return true;
    }
    return false;
  }

  return (
    <div className="w-full space-y-5">
      {/* ── Serial Device ─────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-200/80 bg-white/90 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4 dark:border-zinc-800">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-zinc-100">{t("device.title")}</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">{t("device.description")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void refreshPorts();
              }}
              disabled={isScanning}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-slate-900 hover:bg-slate-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
            >
              {isScanning ? t("device.actions.scanning") : t("device.actions.refresh")}
            </button>
            <button
              type="button"
              onClick={() => {
                void runHealthCheck();
              }}
              disabled={healthActionDisabled}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-slate-900 hover:bg-slate-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
            >
              {isHealthChecking ? t("device.healthCheck.runningAction") : t("device.healthCheck.runAction")}
            </button>
          </div>
        </div>

        <div className="p-6">
          {/* Port grid */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-800/40">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">{t("device.groups.supportedTitle")}</p>
              <p className="mt-0.5 text-[11px] text-slate-400 dark:text-zinc-500">{t("device.groups.supportedDescription")}</p>
              <ul className="mt-2.5 space-y-1.5">{renderPortRows("supported")}</ul>
            </div>
            <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-800/40">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">{t("device.groups.otherTitle")}</p>
              <p className="mt-0.5 text-[11px] text-slate-400 dark:text-zinc-500">{t("device.groups.otherDescription")}</p>
              <ul className="mt-2.5 space-y-1.5">{renderPortRows("other")}</ul>
            </div>
          </div>

          {/* Connect bar */}
          <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                {selected ? (
                  <>
                    <p className="truncate text-xs font-medium text-slate-800 dark:text-zinc-100">
                      {portDisplayName(selected.portName, selected.product, selected.manufacturer)}
                    </p>
                    <p className="mt-0.5 font-mono truncate text-[11px] text-slate-400 dark:text-zinc-500">{selected.portName}</p>
                  </>
                ) : (
                  <p className="text-xs text-slate-400 dark:text-zinc-500">{t("device.selection.emptyHint")}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                {/* Connection status indicator */}
                {selected && (
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        status === "connected"
                          ? "bg-emerald-500"
                          : isReconnecting
                            ? "bg-amber-500"
                            : status === "error" || status === "manual_required"
                              ? "bg-rose-500"
                              : isConnecting || isHealthChecking
                                ? "bg-slate-400 dark:bg-zinc-500"
                                : "bg-transparent"
                      }`}
                    />
                    <span
                      className={`text-[11px] font-medium ${
                        status === "connected"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : isReconnecting
                            ? "text-amber-600 dark:text-amber-400"
                            : status === "error" || status === "manual_required"
                              ? "text-rose-600 dark:text-rose-400"
                              : "text-slate-400 dark:text-zinc-500"
                      }`}
                    >
                      {status === "connected"
                        ? t("device.actions.connected")
                        : isReconnecting
                          ? t("device.badges.reconnecting")
                          : status === "error" || status === "manual_required"
                            ? t("device.badges.error")
                            : isConnecting
                              ? t("device.actions.connecting")
                              : isHealthChecking
                                ? t("device.badges.checking")
                                : null}
                    </span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => {
                    void connectSelectedPort();
                  }}
                  disabled={connectDisabled}
                  className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isConnecting ? t("device.actions.connecting") : t(connectLabelKey)}
                </button>
              </div>
            </div>

            {/* Missing port hint — analogous to bridge network hint */}
            {statusCard?.code === "SELECTED_PORT_MISSING" ? (
              <div className="flex items-start gap-2 border-t border-slate-100 px-4 py-2.5 dark:border-zinc-800">
                <IconInfo />
                <p className="text-[11px] text-slate-500 dark:text-zinc-400">
                  {t("device.port.missingHint", { port: selectedPort ?? "-" })}
                </p>
              </div>
            ) : null}
          </div>

          {/* Status card */}
          <div
            className={`mt-4 rounded-xl border p-4 ${
              statusVariant === "success"
                ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/40 dark:bg-emerald-900/20"
                : statusVariant === "error"
                  ? "border-rose-200 bg-rose-50/70 dark:border-rose-500/40 dark:bg-rose-900/20"
                  : "border-slate-100 bg-slate-50/60 dark:border-zinc-800 dark:bg-zinc-800/30"
            }`}
          >
            <p className="text-xs font-semibold text-slate-900 dark:text-zinc-100">{statusTitle}</p>
            <p className="mt-1 text-xs text-slate-600 dark:text-zinc-300">{statusBody}</p>
            {statusModel.details ? <p className="mt-1 text-[11px] text-slate-400 dark:text-zinc-500">{statusModel.details}</p> : null}
            {showHealthStepOutcomes ? (
              <div className="mt-3 space-y-1.5">
                {healthStepOutcomes.map((stepOutcome) => (
                  <div key={stepOutcome.step} className="flex items-start gap-3 rounded-lg border border-slate-200/70 bg-white/60 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900/30">
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium text-slate-800 dark:text-zinc-100">
                        {t(`device.healthCheck.steps.labels.${stepOutcome.step}`)}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-500 dark:text-zinc-400">{stepOutcome.message}</p>
                      {stepOutcome.details ? <p className="mt-0.5 text-[11px] text-slate-400 dark:text-zinc-500">{stepOutcome.details}</p> : null}
                    </div>
                    <span
                      className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold ${
                        stepOutcome.pass
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                          : "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300"
                      }`}
                    >
                      {stepOutcome.pass ? t("device.healthCheck.steps.outcome.pass") : t("device.healthCheck.steps.outcome.fail")}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            <p className="mt-2 text-[11px] text-slate-400 dark:text-zinc-500">{t("device.status.nextSteps")}</p>
          </div>
        </div>
      </section>

      {/* ── Philips Hue ───────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-200/80 bg-white/90 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4 dark:border-zinc-800">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-zinc-100">{t("device.hue.title")}</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">{t("device.hue.description")}</p>
          </div>
          <span className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold ${hueHeaderBadge.className}`}>
            {hueHeaderBadge.label}
          </span>
        </div>

        {/* Bridge offline card — shown when bridge was registered but is unreachable */}
        {bridgeUnreachable && selectedBridge ? (
          <div className="mx-6 mt-5 rounded-xl border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-500/25 dark:bg-amber-900/10">
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400">
                <IconWifi />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                  {t("device.hue.wizard.offlineTitle")}
                </p>
                <p className="mt-1 text-[11px] text-amber-800 dark:text-amber-300">
                  {t("device.hue.wizard.offlineBody", { name: selectedBridge.name, ip: selectedBridge.ip })}
                </p>
                <ul className="mt-2 space-y-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                  <li>{t("device.hue.wizard.offlineReason1")}</li>
                  <li>{t("device.hue.wizard.offlineReason2")}</li>
                  <li>{t("device.hue.wizard.offlineReason3")}</li>
                </ul>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void discover();
                    }}
                    disabled={isHueDiscovering}
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isHueDiscovering ? t("device.hue.actions.discovering") : t("device.hue.wizard.offlineRediscover")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setHueExpandedStep("discover");
                    }}
                    className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 dark:border-amber-500/30 dark:text-amber-300 dark:hover:bg-amber-900/20"
                  >
                    {t("device.hue.wizard.offlineTryIp")}
                  </button>
                </div>
              </div>
            </div>
            {/* Reset link */}
            <div className="mt-3 border-t border-amber-200/60 pt-2.5 dark:border-amber-500/15">
              <button
                type="button"
                onClick={() => {
                  selectBridge(null);
                }}
                className="text-[11px] font-medium text-amber-600 underline decoration-amber-400/40 underline-offset-2 transition-colors hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200"
              >
                {t("device.hue.wizard.offlineReset")}
              </button>
            </div>
          </div>
        ) : null}

        <div className="p-6 pt-0">
          {/* Empty state guide — no bridge at all, no history */}
          {!selectedBridgeId && bridges.length === 0 && !isHueDiscovering && !bridgeUnreachable ? (
            <div className="mt-5 flex flex-col items-center rounded-xl border border-dashed border-slate-200 bg-slate-50/40 px-6 py-8 text-center dark:border-zinc-700 dark:bg-zinc-800/20">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-400 dark:bg-zinc-800 dark:text-zinc-500">
                <IconBridge />
              </div>
              <p className="mt-3 text-xs font-semibold text-slate-700 dark:text-zinc-300">
                {t("device.hue.wizard.emptyTitle")}
              </p>
              <p className="mt-1 max-w-xs text-[11px] text-slate-500 dark:text-zinc-400">
                {t("device.hue.wizard.emptyBody")}
              </p>
              <button
                type="button"
                onClick={() => {
                  void discover();
                }}
                className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {t("device.hue.wizard.emptyAction")}
              </button>
            </div>
          ) : (
            /* ── Wizard accordion steps ────────────────── */
            <div className="mt-5 divide-y divide-slate-100 rounded-xl border border-slate-100 bg-white/60 dark:divide-zinc-800/70 dark:border-zinc-800 dark:bg-zinc-900/40">

              {/* ── Step 1: Discover ────────────────────── */}
              <div>
                {renderWizardStepHeader(
                  "discover",
                  0,
                  hueStepStates.discover,
                  visualActiveStep === "discover",
                  false,
                  selectedBridge?.name,
                )}
                <div className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${resolvedExpandedStep === "discover" ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
                  <div className="overflow-hidden">
                  <div className="px-4 pb-4">
                    {/* Discover button */}
                    <button
                      type="button"
                      onClick={() => {
                        void discover();
                      }}
                      disabled={isHueDiscovering}
                      className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isHueDiscovering ? t("device.hue.actions.discovering") : t("device.hue.actions.discover")}
                    </button>

                    {/* Bridge list */}
                    {bridges.length > 0 ? (
                      <div className="mt-3 space-y-1.5">
                        {bridges.map((bridge) => {
                          const isSelected = selectedBridgeId === bridge.id;
                          return (
                            <button
                              key={bridge.id}
                              type="button"
                              onClick={() => {
                                selectBridge(bridge.id);
                              }}
                              className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                                isSelected
                                  ? "border-slate-900 bg-slate-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                                  : "border-slate-200 bg-white text-slate-800 hover:border-slate-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-500"
                              }`}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="truncate text-xs font-semibold">{bridge.name}</p>
                                  <p className={`mt-0.5 font-mono text-[11px] ${isSelected ? "text-white/65 dark:text-zinc-600" : "text-slate-400 dark:text-zinc-500"}`}>
                                    {bridge.ip}
                                  </p>
                                </div>
                                {isSelected ? (
                                  <span className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-medium ${
                                    isValidatingCredential
                                      ? "bg-white/15 text-white/80 dark:bg-zinc-900/20 dark:text-zinc-500"
                                      : credentialState === "valid"
                                        ? "bg-emerald-400/25 text-emerald-100 dark:bg-emerald-500/20 dark:text-emerald-400"
                                        : "bg-white/15 text-white/80 dark:bg-zinc-900/20 dark:text-zinc-500"
                                  }`}>
                                    {isValidatingCredential
                                      ? t("device.hue.bridge.checking")
                                      : credentialState === "valid"
                                        ? t("device.hue.bridge.online")
                                        : t("device.hue.wizard.badgeSelected")}
                                  </span>
                                ) : null}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    ) : !isHueDiscovering ? (
                      <p className="mt-2 text-[11px] text-slate-400 dark:text-zinc-500">{t("device.hue.bridge.noBridges")}</p>
                    ) : null}

                    {/* Manual IP */}
                    <div className="mt-3 rounded-lg border border-dashed border-slate-200 bg-slate-50/60 p-3 dark:border-zinc-700 dark:bg-zinc-800/40">
                      <p className="text-[11px] font-semibold text-slate-700 dark:text-zinc-300">{t("device.hue.manualIp.title")}</p>
                      <p className="mt-0.5 text-[11px] text-slate-400 dark:text-zinc-500">{t("device.hue.manualIp.description")}</p>
                      <div className="mt-2 flex gap-2">
                        <input
                          value={manualIp}
                          onChange={(event) => {
                            setManualIp(event.target.value);
                          }}
                          placeholder={t("device.hue.manualIp.placeholder")}
                          className="h-8 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            void submitManualIp();
                          }}
                          disabled={hueManualIpDisabled}
                          className="h-8 shrink-0 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white transition-colors hover:bg-slate-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {t("device.hue.manualIp.submit")}
                        </button>
                      </div>
                      {manualIpError ? <p className="mt-1.5 text-[11px] text-rose-600 dark:text-rose-400">{t(manualIpError)}</p> : null}
                    </div>
                  </div>
                  </div>
                </div>
              </div>

              {/* ── Step 2: Pair ────────────────────────── */}
              <div>
                {renderWizardStepHeader(
                  "pair",
                  1,
                  hueStepStates.pair,
                  visualActiveStep === "pair",
                  isStepLocked("pair"),
                  credentialState === "valid" ? t("device.hue.credential.valid") : undefined,
                )}
                <div className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${resolvedExpandedStep === "pair" && !isStepLocked("pair") ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
                  <div className="overflow-hidden">
                  <div className="px-4 pb-4">
                    <p className="mb-3 text-[11px] text-slate-500 dark:text-zinc-400">
                      {t("device.hue.wizard.pairInstruction")}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        void pair();
                      }}
                      disabled={huePairDisabled}
                      className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isHuePairing ? t("device.hue.actions.pairing") : t("device.hue.actions.pair")}
                    </button>

                    {/* Link button pending hint */}
                    {isHuePairing && hueStatus?.code === "HUE_PAIRING_PENDING_LINK_BUTTON" ? (
                      <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2.5 dark:border-amber-500/30 dark:bg-amber-900/15">
                        <span className="mt-0.5 text-amber-500 dark:text-amber-400"><IconInfo /></span>
                        <p className="text-[11px] text-amber-700 dark:text-amber-300">
                          {t("device.hue.pair.linkButtonHint")}
                        </p>
                      </div>
                    ) : null}

                    {/* Credential repair hint */}
                    {credentialState === "needs_repair" && !bridgeUnreachable && !isHuePairing ? (
                      <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5 dark:border-amber-500/25 dark:bg-amber-900/10">
                        <span className="mt-0.5 text-amber-500 dark:text-amber-400"><IconInfo /></span>
                        <p className="text-[11px] text-amber-700 dark:text-amber-300">
                          {t("device.hue.credential.repairHint")}
                        </p>
                      </div>
                    ) : null}
                  </div>
                  </div>
                </div>
              </div>

              {/* ── Step 3: Area ────────────────────────── */}
              <div>
                {renderWizardStepHeader(
                  "area",
                  2,
                  hueStepStates.area && Boolean(selectedArea?.readiness?.ready),
                  visualActiveStep === "area",
                  isStepLocked("area"),
                  selectedArea?.name,
                )}
                <div className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${resolvedExpandedStep === "area" && !isStepLocked("area") ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
                  <div className="overflow-hidden">
                  <div className="px-4 pb-4">
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <p className="text-[11px] text-slate-500 dark:text-zinc-400">
                        {t("device.hue.wizard.areaInstruction")}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          void refreshAreas();
                        }}
                        disabled={hueAreasDisabled}
                        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-slate-600 transition-colors hover:border-slate-900 hover:bg-slate-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
                      >
                        <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 7A5 5 0 1 1 7 2M12 2v3H9" />
                        </svg>
                        {isLoadingAreas ? t("device.hue.actions.loadingAreas") : t("device.hue.actions.refreshAreas")}
                      </button>
                    </div>

                    {areaGroups.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-5 text-center dark:border-zinc-700/60 dark:bg-zinc-800/30">
                        <p className="text-xs text-slate-400 dark:text-zinc-500">{t("device.hue.areas.empty")}</p>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {areaGroups.map((group) => (
                          <div key={group.roomName}>
                            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-zinc-500">{group.roomName}</p>
                            <ul className="space-y-2">
                              {group.areas.map((area) => {
                                const active = selectedAreaId === area.id;
                                const readinessLabel = area.readiness?.ready
                                  ? t("device.hue.readiness.ready")
                                  : area.readiness
                                    ? t("device.hue.readiness.notReady")
                                    : t("device.hue.readiness.unknown");

                                return (
                                  <li key={area.id}>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        selectArea(area.id);
                                      }}
                                      className={`w-full rounded-xl border px-4 py-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900 ${
                                        active
                                          ? "border-slate-900/20 bg-slate-50 ring-1 ring-slate-900/30 dark:border-zinc-600 dark:bg-zinc-800/60 dark:ring-zinc-600"
                                          : "border-slate-200/80 bg-white hover:border-slate-300 hover:bg-slate-50/50 dark:border-zinc-700/60 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:hover:bg-zinc-800/40"
                                      }`}
                                    >
                                      <div className="flex items-center gap-3">
                                        {/* Radio indicator */}
                                        <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                                          active
                                            ? "border-slate-900 dark:border-zinc-100"
                                            : "border-slate-300 dark:border-zinc-600"
                                        }`}>
                                          {active && (
                                            <div className="h-1.5 w-1.5 rounded-full bg-slate-900 dark:bg-zinc-100" />
                                          )}
                                        </div>

                                        {/* Mini spatial preview */}
                                        <MiniSpatialPreview channelCount={area.channelCount ?? 0} />

                                        {/* Name + channel count + activeStreamer badge */}
                                        <div className="min-w-0 flex-1">
                                          <div className="flex items-center gap-2">
                                            <p className="text-xs font-semibold text-slate-800 dark:text-zinc-100">{area.name}</p>
                                            {area.activeStreamer && (
                                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-amber-500 dark:bg-amber-500/20 dark:text-amber-400">
                                                <span className="h-1 w-1 animate-pulse rounded-full bg-amber-400" />
                                                {t("device.hue.areas.activeStreamer")}
                                              </span>
                                            )}
                                          </div>
                                          <p className="mt-0.5 text-[11px] text-slate-400 dark:text-zinc-500">
                                            {t("device.hue.areas.channels", { count: area.channelCount ?? 0 })}
                                          </p>
                                        </div>

                                        {/* Readiness badge */}
                                        <span
                                          className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold ${
                                            area.readiness?.ready
                                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                                              : area.readiness
                                                ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
                                                : "bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400"
                                          }`}
                                        >
                                          {readinessLabel}
                                        </span>
                                      </div>
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        ))}
                      </div>
                    )}

                    {selectedAreaId ? (
                      <div className="mt-4">
                        <button
                          type="button"
                          onClick={() => {
                            void revalidateArea();
                          }}
                          disabled={hueReadinessDisabled}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-slate-900 hover:bg-slate-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
                        >
                          {isCheckingReadiness ? t("device.hue.actions.checkingReadiness") : t("device.hue.actions.checkReadiness")}
                        </button>
                      </div>
                    ) : null}

                    {/* Channel map */}
                    {selectedAreaId ? (
                      <HueChannelMapPanel
                        channels={areaChannels}
                        isLoading={isLoadingChannels}
                        overrides={channelRegionOverrides}
                        onSetRegion={setChannelRegion}
                      />
                    ) : null}
                  </div>
                  </div>
                </div>
              </div>

              {/* ── Step 4: Ready / Controls ────────────── */}
              <div>
                {renderWizardStepHeader(
                  "ready",
                  3,
                  canStartHue,
                  visualActiveStep === "ready",
                  isStepLocked("ready"),
                  canStartHue && selectedBridge && selectedArea
                    ? t("device.hue.wizard.readySummary", { bridge: selectedBridge.name, area: selectedArea.name })
                    : undefined,
                )}
                <div className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${resolvedExpandedStep === "ready" && !isStepLocked("ready") ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
                  <div className="overflow-hidden">
                  <div className="px-4 pb-4">
                    {/* Runtime checklist */}
                    {showRuntimeChecklist ? (
                      <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-500/30 dark:bg-amber-900/15">
                        <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-300">{t("device.hue.runtime.checklist.title")}</p>
                        <ul className="mt-1 space-y-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                          {isValidatingCredential || credentialState === "unknown" ? (
                            <li>{t("device.hue.runtime.checklist.waitCredential")}</li>
                          ) : null}
                          {isReadinessStale ? <li>{t("device.hue.runtime.checklist.revalidate")}</li> : null}
                        </ul>
                      </div>
                    ) : null}

                    {/* Summary */}
                    {canStartHue && selectedBridge && selectedArea ? (
                      <p className="mb-3 text-xs text-emerald-700 dark:text-emerald-400">
                        {t("device.hue.successSummary", {
                          bridge: selectedBridge.name,
                          area: selectedArea.name,
                          readiness: t("device.hue.readiness.ready"),
                        })}
                      </p>
                    ) : null}

                    {/* Action buttons */}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          void startRuntime();
                        }}
                        disabled={hueStartDisabled}
                        className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t("device.hue.actions.start")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void stopHue(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE);
                        }}
                        disabled={!runtimeStatus || isRuntimeMutating}
                        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-slate-900 hover:bg-slate-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
                      >
                        {t("device.hue.actions.stop")}
                      </button>
                    </div>

                    {/* Runtime targets */}
                    {runtimeTargets.length > 0 ? (
                      <div className="mt-3 space-y-2">
                        {runtimeTargets.map((targetRow) => {
                          const targetLocked = isRuntimeMutating || targetRow.state === "Reconnecting";
                          return (
                            <div
                              key={targetRow.target}
                              className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-800/30"
                            >
                              <div className="min-w-0">
                                <p className="text-[11px] font-semibold text-slate-800 dark:text-zinc-100">
                                  {t(`device.hue.runtime.targets.${targetRow.target}.title`)}
                                </p>
                                {targetRow.remainingAttempts !== undefined || targetRow.nextAttemptMs !== undefined ? (
                                  <p className="mt-0.5 text-[11px] text-slate-400 dark:text-zinc-500">
                                    {t("device.hue.runtime.retryStatus", {
                                      remaining: targetRow.remainingAttempts ?? "-",
                                      nextMs: targetRow.nextAttemptMs ?? "-",
                                    })}
                                  </p>
                                ) : null}
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                {targetRow.state === "Reconnecting" || targetRow.remainingAttempts !== undefined ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      void stopHue(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE);
                                    }}
                                    disabled={isRuntimeMutating}
                                    className="shrink-0 rounded border border-rose-200 px-2.5 py-1 text-[11px] font-medium text-rose-700 transition-colors hover:border-rose-600 hover:bg-rose-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-700/50 dark:text-rose-400 dark:hover:border-rose-500 dark:hover:bg-rose-500 dark:hover:text-white"
                                  >
                                    {t("device.hue.runtime.actions.stopRetrying")}
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => {
                                    void retryRuntimeTarget(targetRow.target);
                                  }}
                                  disabled={targetLocked}
                                  className="shrink-0 rounded border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-700 transition-colors hover:border-slate-900 hover:bg-slate-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
                                >
                                  {t(
                                    targetRow.actionHint
                                      ? `device.hue.runtime.actions.${targetRow.actionHint}`
                                      : `device.hue.runtime.targets.${targetRow.target}.retry`
                                  )}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}

                    {/* Status cards — compact, side by side */}
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                      <div
                        className={`rounded-lg border p-3 ${
                          hueStatusModel.variant === "success"
                            ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/40 dark:bg-emerald-900/20"
                            : hueStatusModel.variant === "error"
                              ? "border-rose-200 bg-rose-50/70 dark:border-rose-500/40 dark:bg-rose-900/20"
                              : "border-slate-100 bg-slate-50/60 dark:border-zinc-800 dark:bg-zinc-800/30"
                        }`}
                      >
                        <p className="text-[11px] font-semibold text-slate-800 dark:text-zinc-100">{t(hueStatusModel.titleKey)}</p>
                        <p className="mt-0.5 text-[11px] text-slate-600 dark:text-zinc-300">{t(hueStatusModel.bodyKey)}</p>
                      </div>

                      <div
                        className={`rounded-lg border p-3 ${
                          hueRuntimeModel.variant === "success"
                            ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/40 dark:bg-emerald-900/20"
                            : hueRuntimeModel.variant === "error"
                              ? "border-rose-200 bg-rose-50/70 dark:border-rose-500/40 dark:bg-rose-900/20"
                              : "border-slate-100 bg-slate-50/60 dark:border-zinc-800 dark:bg-zinc-800/30"
                        }`}
                      >
                        <p className="text-[11px] font-semibold text-slate-800 dark:text-zinc-100">{t(hueRuntimeModel.titleKey)}</p>
                        <p className="mt-0.5 text-[11px] text-slate-600 dark:text-zinc-300">{t(hueRuntimeModel.bodyKey)}</p>
                        {hueRuntimeModel.retry ? (
                          <p className="mt-0.5 text-[11px] text-slate-400 dark:text-zinc-500">
                            {t(hueRuntimeModel.retry.labelKey, {
                              remaining: hueRuntimeModel.retry.remainingAttempts ?? "-",
                              nextMs: hueRuntimeModel.retry.nextAttemptMs ?? "-",
                            })}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
