import { useTranslation } from "react-i18next";

import { useDeviceConnection } from "../../device/useDeviceConnection";

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
    status,
    groupedPorts,
    ports,
    selectedPort,
    connectedPort,
    isScanning,
    isConnecting,
    canConnect,
    statusCard,
    refreshPorts,
    selectPort,
    connectSelectedPort,
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

  const statusVariant = statusCard?.variant ?? "info";
  const isRefreshRateLimited = statusCard?.code === "REFRESH_RATE_LIMITED";
  const statusTitle =
    isRefreshRateLimited
      ? t("device.status.rateLimitedTitle")
      : statusCard?.code === "SELECTED_PORT_MISSING"
      ? t("device.status.missingTitle")
      : statusVariant === "success"
        ? t("device.status.connectedTitle")
        : statusVariant === "error"
          ? t("device.status.errorTitle")
          : status === "scanning"
            ? t("device.status.scanningTitle")
            : t("device.status.idleTitle");
  const statusBody =
    isRefreshRateLimited
      ? t("device.status.rateLimitedBody")
      : statusCard?.code === "SELECTED_PORT_MISSING"
      ? t("device.status.missingBody")
      : statusVariant === "success"
        ? t("device.status.connectedBody", {
            port: connectedPort ?? selectedPort ?? "-",
          })
        : statusVariant === "error"
          ? t("device.status.errorBody")
          : status === "scanning"
            ? t("device.status.scanningBody")
            : t("device.status.idleBody");

  const refreshHint = isScanning
    ? t("device.actions.scanning")
    : isRefreshRateLimited
      ? t("device.actions.refreshLimited")
      : t("device.actions.ready");

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
    <section className="mx-auto w-full max-w-3xl rounded-2xl border border-slate-200/80 bg-white/90 p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80 sm:p-8">
      <h2 className="text-xl font-semibold tracking-tight">{t("device.title")}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-zinc-300">{t("device.description")}</p>

      <div className="mt-6 flex items-center justify-between gap-3">
        <p className="text-sm text-slate-600 dark:text-zinc-300">{refreshHint}</p>
        <button
          type="button"
          onClick={() => {
            void refreshPorts();
          }}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
            isRefreshRateLimited
              ? "border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-500/60 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/20"
              : "border-slate-300 bg-white text-slate-900 hover:border-slate-900 hover:bg-slate-900 hover:text-white dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
          }`}
          disabled={isScanning}
        >
          {isScanning ? t("device.actions.scanning") : t("device.actions.refresh")}
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
          isRefreshRateLimited
            ? "border-amber-200 bg-amber-50/80 dark:border-amber-500/50 dark:bg-amber-900/20"
            : statusVariant === "success"
            ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/40 dark:bg-emerald-900/20"
            : statusVariant === "error"
              ? "border-rose-200 bg-rose-50/70 dark:border-rose-500/40 dark:bg-rose-900/20"
              : "border-slate-200 bg-slate-50/70 dark:border-zinc-700 dark:bg-zinc-800/40"
        }`}
      >
        <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">{statusTitle}</h3>
        <p className="mt-1 text-sm text-slate-700 dark:text-zinc-200">{statusBody}</p>
        {statusCard?.details ? <p className="mt-2 text-xs text-slate-500 dark:text-zinc-400">{statusCard.details}</p> : null}
        <p className="mt-3 text-xs text-slate-600 dark:text-zinc-300">{t("device.status.nextSteps")}</p>
      </div>
    </section>
  );
}
