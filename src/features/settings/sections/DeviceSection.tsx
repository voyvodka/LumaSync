import { useTranslation } from "react-i18next";

import { HUE_RUNTIME_TRIGGER_SOURCE } from "../../../shared/contracts/hue";
import { buildDeviceStatusCard } from "../../device/deviceStatusCard";
import { buildHueRuntimeStatusCard } from "../../device/hueRuntimeStatusCard";
import { buildHueStatusCard } from "../../device/hueStatusCard";
import { useDeviceConnection } from "../../device/useDeviceConnection";
import { useHueOnboarding } from "../../device/useHueOnboarding";
import { stopHue } from "../../mode/modeApi";

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
    discover,
    selectBridge,
    setManualIp,
    submitManualIp,
    pair,
    refreshAreas,
    selectArea,
    revalidateArea,
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

  const refreshHint = isScanning
    ? t("device.actions.scanning")
    : t("device.actions.ready");

  const healthActionDisabled = isScanning || isConnecting || isReconnecting || isHealthChecking || !selectedPort;

  const hueManualIpDisabled = isHueDiscovering || !manualIp || Boolean(manualIpError);
  const huePairDisabled = isHuePairing || !selectedBridge;
  const hueAreasDisabled = !selectedBridge || credentialState !== "valid" || isLoadingAreas;
  const hueReadinessDisabled = !selectedBridge || !selectedAreaId || credentialState !== "valid" || isCheckingReadiness;
  const hueStartDisabled =
    !canStartHue
    || isValidatingCredential
    || credentialState !== "valid"
    || isReadinessStale;

  const hueStatusModel = buildHueStatusCard({
    status: hueStatus,
    credentialState,
    isValidatingCredential,
    isPairing: isHuePairing,
    isCheckingReadiness,
  });

  const hueRuntimeModel = buildHueRuntimeStatusCard({
    status: runtimeStatus,
  });

  const showRuntimeChecklist = isValidatingCredential || credentialState === "unknown" || isReadinessStale;

  const hueStepStates = {
    discover: selectedBridgeId !== null,
    pair: credentialState === "valid",
    area: Boolean(selectedAreaId),
    ready: canStartHue,
  };

  const renderPortRows = (kind: "supported" | "other") => {
    const list = kind === "supported" ? groupedPorts.supported : groupedPorts.other;

    if (list.length === 0) {
      return (
        <li className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-300">
          {t("device.groups.empty")}
        </li>
      );
    }

    return list.map((port) => {
      const active = selectedPort === port.portName;
      const connected = connectedPort === port.portName;

      return (
        <li key={port.portName}>
          <button
            type="button"
            onClick={() => {
              selectPort(port.portName);
            }}
            className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
              active
                ? "border-slate-900 bg-slate-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                : "border-slate-300 bg-white text-slate-800 hover:border-slate-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-500"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {portDisplayName(port.portName, port.product, port.manufacturer)}
                </p>
                <p className={`mt-1 truncate text-xs ${active ? "text-white/85 dark:text-zinc-700" : "text-slate-500 dark:text-zinc-400"}`}>
                  {t("device.fields.port")}: {port.portName}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2 text-xs">
                <span
                  className={`rounded-md px-2 py-1 font-medium ${
                    port.isSupported
                      ? active
                        ? "bg-emerald-400/20 text-emerald-50 dark:bg-emerald-400/25 dark:text-emerald-800"
                        : "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                      : active
                        ? "bg-amber-400/20 text-amber-50 dark:bg-amber-300/30 dark:text-amber-900"
                        : "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
                  }`}
                >
                  {port.isSupported ? t("device.badges.supported") : t("device.badges.other")}
                </span>

                {connected ? (
                  <span className={`rounded-md px-2 py-1 font-medium ${active ? "bg-white/20 text-white dark:bg-zinc-900/15 dark:text-zinc-700" : "bg-slate-200 text-slate-700 dark:bg-zinc-800 dark:text-zinc-200"}`}>
                    {t("device.badges.connected")}
                  </span>
                ) : null}
              </div>
            </div>
          </button>
        </li>
      );
    });
  };

  return (
    <section className="w-full rounded-2xl border border-slate-200/80 bg-white/90 p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80 sm:p-8">
      <h2 className="text-xl font-semibold tracking-tight">{t("device.title")}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-zinc-300">{t("device.description")}</p>

      <div className="mt-6 flex items-center justify-between gap-3">
        <p className="text-sm text-slate-600 dark:text-zinc-300">{refreshHint}</p>
        <button
          type="button"
          onClick={() => {
            void refreshPorts();
          }}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 transition-colors hover:border-slate-900 hover:bg-slate-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
          disabled={isScanning}
        >
          {isScanning ? t("device.actions.scanning") : t("device.actions.refresh")}
        </button>
      </div>

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => {
            void runHealthCheck();
          }}
          disabled={healthActionDisabled}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 transition-colors hover:border-slate-900 hover:bg-slate-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
        >
          {isHealthChecking ? t("device.healthCheck.runningAction") : t("device.healthCheck.runAction")}
        </button>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-800/40">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">{t("device.groups.supportedTitle")}</h3>
          <p className="mt-1 text-xs text-slate-600 dark:text-zinc-300">{t("device.groups.supportedDescription")}</p>
          <ul className="mt-3 space-y-2">{renderPortRows("supported")}</ul>
        </div>

        <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-800/40">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">{t("device.groups.otherTitle")}</h3>
          <p className="mt-1 text-xs text-slate-600 dark:text-zinc-300">{t("device.groups.otherDescription")}</p>
          <ul className="mt-3 space-y-2">{renderPortRows("other")}</ul>
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-slate-200/80 bg-slate-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-800/30">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">{t("device.selection.title")}</h3>
        <p className="mt-1 text-xs text-slate-600 dark:text-zinc-300">{t("device.selection.description")}</p>

        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <select
            value={selectedPort ?? ""}
            onChange={(event) => {
              selectPort(event.target.value || null);
            }}
            className="h-10 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          >
            <option value="">{t("device.selection.placeholder")}</option>
            {ports.map((port) => (
              <option key={port.portName} value={port.portName}>
                {port.portName}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => {
              void connectSelectedPort();
            }}
            disabled={connectDisabled}
            className="h-10 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {isConnecting ? t("device.actions.connecting") : t(connectLabelKey)}
          </button>
        </div>

        <p className="mt-2 text-xs text-slate-600 dark:text-zinc-300">
          {selected
            ? t("device.selection.selectedHint", {
                port: selected.portName,
              })
            : t("device.selection.emptyHint")}
        </p>
      </div>

      <div
        className={`mt-6 rounded-xl border p-4 ${
          statusVariant === "success"
            ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/40 dark:bg-emerald-900/20"
            : statusVariant === "error"
              ? "border-rose-200 bg-rose-50/70 dark:border-rose-500/40 dark:bg-rose-900/20"
              : "border-slate-200 bg-slate-50/70 dark:border-zinc-700 dark:bg-zinc-800/40"
        }`}
      >
        <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">{statusTitle}</h3>
        <p className="mt-1 text-sm text-slate-700 dark:text-zinc-200">{statusBody}</p>
        {statusModel.details ? <p className="mt-2 text-xs text-slate-500 dark:text-zinc-400">{statusModel.details}</p> : null}
        {showHealthStepOutcomes ? (
          <div className="mt-3 rounded-lg border border-slate-200/80 bg-white/60 p-3 dark:border-zinc-700 dark:bg-zinc-900/30">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-zinc-300">
              {t("device.healthCheck.steps.title")}
            </p>
            <ul className="mt-2 space-y-2">
              {healthStepOutcomes.map((stepOutcome) => (
                <li key={stepOutcome.step} className="rounded-md border border-slate-200/70 bg-slate-50/80 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800/50">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-800 dark:text-zinc-100">
                      {t(`device.healthCheck.steps.labels.${stepOutcome.step}`)}
                    </span>
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-semibold ${
                        stepOutcome.pass
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                          : "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300"
                      }`}
                    >
                      {stepOutcome.pass ? t("device.healthCheck.steps.outcome.pass") : t("device.healthCheck.steps.outcome.fail")}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-600 dark:text-zinc-300">{stepOutcome.message}</p>
                  {stepOutcome.details ? <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">{stepOutcome.details}</p> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="mt-3 text-xs text-slate-600 dark:text-zinc-300">{t("device.status.nextSteps")}</p>
      </div>

      <div className="mt-6 rounded-xl border border-slate-200/80 bg-slate-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-800/30">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">{t("device.hue.title")}</h3>
            <p className="mt-1 text-xs text-slate-600 dark:text-zinc-300">{t("device.hue.description")}</p>
          </div>

          <span
            className={`rounded-md px-2 py-1 text-xs font-semibold ${
              credentialState === "valid"
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                : "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
            }`}
          >
            {credentialState === "valid" ? t("device.hue.credential.valid") : t("device.hue.credential.needsRepair")}
          </span>
        </div>

        <p className="mt-3 text-xs text-slate-600 dark:text-zinc-300">
          {t("device.hue.credential.line", {
            state:
              credentialState === "valid"
                ? t("device.hue.credential.valid")
                : t("device.hue.credential.needsRepair"),
          })}
        </p>

        <div className="mt-4 grid gap-2 sm:grid-cols-4">
          {([
            { key: "discover", label: t("device.hue.steps.discover") },
            { key: "pair", label: t("device.hue.steps.pair") },
            { key: "area", label: t("device.hue.steps.area") },
            { key: "ready", label: t("device.hue.steps.ready") },
          ] as const).map((stepModel) => {
            const completed = hueStepStates[stepModel.key];
            const active = hueStep === stepModel.key;
            return (
              <div
                key={stepModel.key}
                className={`rounded-lg border px-3 py-2 text-xs ${
                  completed
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
                    : active
                      ? "border-slate-400 bg-slate-100 text-slate-800 dark:border-zinc-500 dark:bg-zinc-700/40 dark:text-zinc-100"
                      : "border-slate-200 bg-white text-slate-500 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400"
                }`}
              >
                <p className="font-semibold">{stepModel.label}</p>
              </div>
            );
          })}
        </div>

        <div className="mt-4 rounded-lg border border-slate-200 bg-white/80 p-3 dark:border-zinc-700 dark:bg-zinc-900/50">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void discover();
              }}
              disabled={isHueDiscovering}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-900 transition-colors hover:border-slate-900 hover:bg-slate-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
            >
              {isHueDiscovering ? t("device.hue.actions.discovering") : t("device.hue.actions.discover")}
            </button>

            <select
              value={selectedBridgeId ?? ""}
              onChange={(event) => {
                selectBridge(event.target.value || null);
              }}
              className="h-8 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-xs text-slate-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            >
              <option value="">{t("device.hue.bridge.placeholder")}</option>
              {bridges.map((bridge) => (
                <option key={bridge.id} value={bridge.id}>
                  {bridge.name} ({bridge.ip})
                </option>
              ))}
            </select>
          </div>

          <div className="mt-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 dark:border-zinc-600 dark:bg-zinc-800/50">
            <p className="text-xs font-semibold text-slate-800 dark:text-zinc-100">{t("device.hue.manualIp.title")}</p>
            <p className="mt-1 text-xs text-slate-600 dark:text-zinc-300">{t("device.hue.manualIp.description")}</p>

            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                value={manualIp}
                onChange={(event) => {
                  setManualIp(event.target.value);
                }}
                placeholder={t("device.hue.manualIp.placeholder")}
                className="h-8 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-xs text-slate-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
              <button
                type="button"
                onClick={() => {
                  void submitManualIp();
                }}
                disabled={hueManualIpDisabled}
                className="h-8 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {t("device.hue.manualIp.submit")}
              </button>
            </div>

            {manualIpError ? <p className="mt-2 text-xs text-rose-600 dark:text-rose-300">{t(manualIpError)}</p> : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void pair();
              }}
              disabled={huePairDisabled}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-900 transition-colors hover:border-slate-900 hover:bg-slate-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
            >
              {isHuePairing ? t("device.hue.actions.pairing") : t("device.hue.actions.pair")}
            </button>
            {credentialState === "needs_repair" ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">{t("device.hue.credential.repairHint")}</p>
            ) : null}
          </div>

          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/80 p-3 dark:border-zinc-700 dark:bg-zinc-800/40">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-800 dark:text-zinc-100">{t("device.hue.areas.title")}</p>
              <button
                type="button"
                onClick={() => {
                  void refreshAreas();
                }}
                disabled={hueAreasDisabled}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-900 transition-colors hover:border-slate-900 hover:bg-slate-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
              >
                {isLoadingAreas ? t("device.hue.actions.loadingAreas") : t("device.hue.actions.refreshAreas")}
              </button>
            </div>

            {areaGroups.length === 0 ? (
              <p className="mt-2 text-xs text-slate-600 dark:text-zinc-300">{t("device.hue.areas.empty")}</p>
            ) : (
              <div className="mt-2 space-y-3">
                {areaGroups.map((group) => (
                  <div key={group.roomName}>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">{group.roomName}</p>
                    <ul className="mt-1 space-y-2">
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
                              className={`w-full rounded-lg border px-3 py-2 text-left ${
                                active
                                  ? "border-slate-900 bg-slate-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                                  : "border-slate-300 bg-white text-slate-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                              }`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <p className="text-xs font-semibold">{area.name}</p>
                                  <p className={`mt-1 text-[11px] ${active ? "text-white/85 dark:text-zinc-700" : "text-slate-500 dark:text-zinc-400"}`}>
                                    {t("device.hue.areas.channels", { count: area.channelCount ?? 0 })}
                                  </p>
                                  <p className={`mt-1 text-[11px] ${active ? "text-white/85 dark:text-zinc-700" : "text-slate-600 dark:text-zinc-300"}`}>
                                    {area.readiness?.message ?? t("device.hue.readiness.pending")}
                                  </p>
                                  {area.readiness && !area.readiness.ready ? (
                                    <p className={`mt-1 text-[11px] ${active ? "text-amber-200 dark:text-amber-800" : "text-amber-700 dark:text-amber-300"}`}>
                                      {t("device.hue.readiness.recoveryHint")}
                                    </p>
                                  ) : null}
                                </div>
                                <span
                                  className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
                                    area.readiness?.ready
                                      ? active
                                        ? "bg-emerald-300/30 text-emerald-100 dark:bg-emerald-500/20 dark:text-emerald-900"
                                        : "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                                      : area.readiness
                                        ? active
                                          ? "bg-amber-300/30 text-amber-100 dark:bg-amber-500/20 dark:text-amber-900"
                                          : "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
                                        : active
                                          ? "bg-white/20 text-white dark:bg-zinc-900/15 dark:text-zinc-700"
                                          : "bg-slate-200 text-slate-700 dark:bg-zinc-700 dark:text-zinc-200"
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

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void revalidateArea();
                }}
                disabled={hueReadinessDisabled}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-900 transition-colors hover:border-slate-900 hover:bg-slate-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
              >
                {isCheckingReadiness ? t("device.hue.actions.checkingReadiness") : t("device.hue.actions.checkReadiness")}
              </button>

              <button
                type="button"
                disabled={hueStartDisabled}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {t("device.hue.actions.start")}
              </button>

              <button
                type="button"
                onClick={() => {
                  void stopHue(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE);
                }}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-900 transition-colors hover:border-slate-900 hover:bg-slate-900 hover:text-white dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
              >
                {t("device.hue.actions.stop")}
              </button>
            </div>

            {showRuntimeChecklist ? (
              <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/60 p-2 dark:border-amber-500/40 dark:bg-amber-900/20">
                <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-200">{t("device.hue.runtime.checklist.title")}</p>
                <ul className="mt-1 space-y-1 text-[11px] text-amber-700 dark:text-amber-300">
                  {isValidatingCredential || credentialState === "unknown" ? (
                    <li>{t("device.hue.runtime.checklist.waitCredential")}</li>
                  ) : null}
                  {isReadinessStale ? <li>{t("device.hue.runtime.checklist.revalidate")}</li> : null}
                </ul>
              </div>
            ) : null}

            {runtimeTargets.length > 0 ? (
              <div className="mt-3 space-y-2">
                {runtimeTargets.map((targetRow) => {
                  const targetLocked = targetRow.state === "Reconnecting";
                  return (
                    <div
                      key={targetRow.target}
                      className="rounded-lg border border-slate-200 bg-white/80 p-2 dark:border-zinc-700 dark:bg-zinc-900/40"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-slate-800 dark:text-zinc-100">
                          {t(`device.hue.runtime.targets.${targetRow.target}.title`)}
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            void retryRuntimeTarget(targetRow.target);
                          }}
                          disabled={targetLocked}
                          className="rounded border border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-100"
                        >
                          {t(`device.hue.runtime.targets.${targetRow.target}.retry`)}
                        </button>
                      </div>
                      {targetRow.remainingAttempts !== undefined || targetRow.nextAttemptMs !== undefined ? (
                        <p className="mt-1 text-[11px] text-slate-500 dark:text-zinc-400">
                          {t("device.hue.runtime.retryStatus", {
                            remaining: targetRow.remainingAttempts ?? "-",
                            nextMs: targetRow.nextAttemptMs ?? "-",
                          })}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {canStartHue && selectedBridge && selectedArea ? (
              <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">
                {t("device.hue.successSummary", {
                  bridge: selectedBridge.name,
                  area: selectedArea.name,
                  readiness: t("device.hue.readiness.ready"),
                })}
              </p>
            ) : null}
          </div>
        </div>

        <div
          className={`mt-4 rounded-lg border p-3 ${
            hueStatusModel.variant === "success"
              ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/40 dark:bg-emerald-900/20"
              : hueStatusModel.variant === "error"
                ? "border-rose-200 bg-rose-50/70 dark:border-rose-500/40 dark:bg-rose-900/20"
                : "border-slate-200 bg-white/70 dark:border-zinc-700 dark:bg-zinc-900/30"
          }`}
        >
          <h4 className="text-xs font-semibold text-slate-900 dark:text-zinc-100">{t(hueStatusModel.titleKey)}</h4>
          <p className="mt-1 text-xs text-slate-700 dark:text-zinc-200">{t(hueStatusModel.bodyKey)}</p>
          {hueStatusModel.details ? <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">{hueStatusModel.details}</p> : null}
        </div>

        <div
          className={`mt-3 rounded-lg border p-3 ${
            hueRuntimeModel.variant === "success"
              ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/40 dark:bg-emerald-900/20"
              : hueRuntimeModel.variant === "error"
                ? "border-rose-200 bg-rose-50/70 dark:border-rose-500/40 dark:bg-rose-900/20"
                : "border-slate-200 bg-white/70 dark:border-zinc-700 dark:bg-zinc-900/30"
          }`}
        >
          <h4 className="text-xs font-semibold text-slate-900 dark:text-zinc-100">{t(hueRuntimeModel.titleKey)}</h4>
          <p className="mt-1 text-xs text-slate-700 dark:text-zinc-200">{t(hueRuntimeModel.bodyKey)}</p>
          {hueRuntimeModel.triggerSourceKey ? (
            <p className="mt-1 text-[11px] text-slate-500 dark:text-zinc-400">{t(hueRuntimeModel.triggerSourceKey)}</p>
          ) : null}
          {hueRuntimeModel.retry ? (
            <p className="mt-1 text-[11px] text-slate-500 dark:text-zinc-400">
              {t(hueRuntimeModel.retry.labelKey, {
                remaining: hueRuntimeModel.retry.remainingAttempts ?? "-",
                nextMs: hueRuntimeModel.retry.nextAttemptMs ?? "-",
              })}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
