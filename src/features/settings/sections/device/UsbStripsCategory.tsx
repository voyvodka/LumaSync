import { useCallback, useId, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";

import type { UsbStripPlacement } from "@/shared/contracts/roomMap";
import { buildDeviceStatusCard } from "@/features/device/deviceStatusCard";
import type { UseDeviceConnectionResult } from "@/features/device/useDeviceConnection";
import { deriveLocalSink } from "@/features/device/localSink";
import { IconRefresh } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/Button";
import { cx } from "@/shared/ui/cx";
import { EmptyState } from "@/shared/ui/EmptyState";

import { PairedStripsGroup } from "./PairedStripsGroup";
import { OtherSerialPorts, SupportedPortCard } from "./UsbPortCards";
import { UsbStripSettings } from "./UsbStripSettings";
import { ensureStripForPort } from "./usbStripRoster";

export interface UsbStripsCategoryProps {
  isActive: boolean;
  device: UseDeviceConnectionResult;
  /**
   * `pairedStrips` is hydrated by the parent from `shellStore` so the Hue
   * category's placement load and this one stay a single read. The child
   * writes back through `setPairedStrips` after it persists.
   */
  pairedStrips: UsbStripPlacement[];
  setPairedStrips: Dispatch<SetStateAction<UsbStripPlacement[]>>;
  persistError: boolean;
  /** Raises the shared persist banner and re-arms its 3 s auto-dismiss. */
  flagPersistError: () => void;
  clearPersistError: () => void;
  onNavigateToRoomMap?: () => void;
  /** The bound WLED panel, if any: its colour order is set on the device. */
  activeWledIp?: string | null;
}

const STATUS_TONE_CLASS = { success: "is-ok", error: "is-err", info: "is-info" } as const;

export function UsbStripsCategory({
  isActive,
  device,
  pairedStrips,
  setPairedStrips,
  persistError,
  flagPersistError,
  clearPersistError,
  onNavigateToRoomMap,
  activeWledIp = null,
}: UsbStripsCategoryProps) {
  const { t } = useTranslation();
  const controllerTitleId = useId();
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
    lastSuccessfulPort,
    statusCard,
    latestHealthCheck,
    refreshPorts,
    selectPort,
    connectSelectedPort,
    runHealthCheck,
  } = device;

  const supportedPorts = ports.filter((port) => port.isSupported);
  const otherPorts = ports.filter((port) => !port.isSupported);

  const statusModel = buildDeviceStatusCard({
    status,
    statusCard,
    connectedPort,
    isReconnecting,
    isHealthChecking,
    latestHealthCheck,
    ports,
  });
  const healthStepOutcomes = statusModel.healthSteps ?? [];
  const showHealthStepOutcomes = latestHealthCheck !== null && healthStepOutcomes.length > 0;
  // With nothing enumerated the empty state below says it, with the Rescan beside it.
  const showStatus = statusModel.code !== "NO_PORTS";

  const localSink = deriveLocalSink(isConnected, connectedPort ?? null, activeWledIp);
  // Auto-recovery is not busy: pressing Connect is how the user takes over
  // from it, which the reconnecting copy invites.
  const controllerBusy = isScanning || isConnecting || isHealthChecking;

  const rescan = useCallback(() => {
    void refreshPorts();
  }, [refreshPorts]);

  const [addingToRoster, setAddingToRoster] = useState(false);
  const addToRoster = useCallback(
    async (portName: string, previousPort: string | null) => {
      setAddingToRoster(true);
      try {
        setPairedStrips(await ensureStripForPort(portName, previousPort));
        clearPersistError();
      } catch (e) {
        console.error("[LumaSync] UsbStripsCategory: adding the connected strip to the roster failed", e);
        flagPersistError();
      } finally {
        setAddingToRoster(false);
      }
    },
    [setPairedStrips, clearPersistError, flagPersistError],
  );

  // Between a connect landing and its roster write settling, the connected
  // port is briefly missing from the list; the "not in the list" callout
  // waits it out rather than flashing a live Add button.
  const [connectInFlight, setConnectInFlight] = useState(false);

  // The one way a strip is added: connecting its controller. The roster entry
  // follows a connect the user asked for, never a boot auto-reconnect, so an
  // existing setup never gains a strip it did not ask for.
  const handleConnect = useCallback(
    async (portName: string) => {
      // Read before the connect overwrites it: the port that was driving the
      // strip until now decides whether an unlinked placement is this one's.
      const previousPort = connectedPort ?? lastSuccessfulPort ?? null;
      setConnectInFlight(true);
      try {
        selectPort(portName);
        const connected = await connectSelectedPort();
        if (connected) await addToRoster(portName, previousPort);
      } finally {
        setConnectInFlight(false);
      }
    },
    [connectedPort, lastSuccessfulPort, selectPort, connectSelectedPort, addToRoster],
  );

  return (
    <div className="lm-device-cat-body" hidden={!isActive}>
      <div className="lm-device-head">
        <div>
          <h1>{t("device:page.header.usbTitle")}</h1>
          <div className="lm-device-head-sub">
            {connectedPort
              ? t("device:page.header.usbSub", { count: 1 })
              : t("device:page.header.usbSubNone")}
          </div>
        </div>
        <div className="lm-device-head-actions">
          <Button onClick={rescan} busy={isScanning}>
            <IconRefresh />
            <span>{isScanning ? t("device:actions.scanning") : t("device:page.actions.rescan")}</span>
          </Button>
        </div>
      </div>

      <section className="lm-settings-group" aria-labelledby={controllerTitleId} data-testid="usb-controller">
        <div className="lm-settings-group-h">
          <h2 className="t" id={controllerTitleId}>{t("device:page.usb.controller.title")}</h2>
          <span className="sub">
            {t("device:page.usb.controller.count", { count: supportedPorts.length })}
          </span>
        </div>
        <div className="lm-usb-group-body">
          {/* Always mounted and never `hidden`: a live region that enters the
              accessibility tree together with its text is not announced. Empty,
              it takes no space. The step list stays outside, or every check
              would read a dozen nodes aloud. */}
          <div
            role="status"
            aria-live="polite"
            className={cx(
              "lm-usb-live",
              showStatus && `lm-usb-status lm-status-banner ${STATUS_TONE_CLASS[statusModel.variant]}`,
            )}
            data-testid="usb-status"
          >
            {showStatus ? (
              <>
                <p className="lm-usb-status-title">{t(statusModel.titleKey)}</p>
                <p className="lm-usb-status-body">
                  {t(statusModel.bodyKey, {
                    port: (statusModel.code === "CONNECTING" ? selectedPort : connectedPort ?? selectedPort) ?? "-",
                  })}
                </p>
                {statusModel.detailsKey ? (
                  <p className="lm-usb-status-body">{t(statusModel.detailsKey)}</p>
                ) : statusModel.details ? (
                  <p className="lm-usb-status-detail">{statusModel.details}</p>
                ) : null}
                {statusCard?.code === "SELECTED_PORT_MISSING" ? (
                  <p className="lm-usb-status-body">
                    {t("device:port.missingHint", { port: selectedPort ?? "-" })}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
          {showStatus && showHealthStepOutcomes ? (
            <div className="lm-usb-status-steps" data-testid="usb-health-steps">
              {healthStepOutcomes.map((stepOutcome) => (
                <div
                  key={stepOutcome.step}
                  data-testid={`health-step-${stepOutcome.step}`}
                  className="lm-usb-step"
                >
                  <div className="lm-usb-step-tx">
                    <p className="lm-usb-step-name">
                      {t(`device:healthCheck.steps.labels.${stepOutcome.step}`)}
                    </p>
                    {stepOutcome.text ? (
                      <>
                        <p className="lm-usb-step-line">{t(stepOutcome.text.labelKey)}</p>
                        <p className="lm-usb-step-hint">{t(stepOutcome.text.hintKey)}</p>
                        {stepOutcome.text.details ? (
                          <p className="lm-usb-status-detail">{stepOutcome.text.details}</p>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <p className="lm-usb-step-line">{stepOutcome.message}</p>
                        {stepOutcome.details ? (
                          <p className="lm-usb-status-detail">{stepOutcome.details}</p>
                        ) : null}
                      </>
                    )}
                  </div>
                  <span className={cx("lm-usb-step-outcome", stepOutcome.pass ? "is-pass" : "is-fail")}>
                    {stepOutcome.pass
                      ? t("device:healthCheck.steps.outcome.pass")
                      : t("device:healthCheck.steps.outcome.fail")}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {ports.length === 0 ? (
            <EmptyState
              title={t("device:status.noPortsTitle")}
              body={t("device:status.noPortsBody")}
              action={
                <Button size="md" onClick={rescan} busy={isScanning}>
                  <IconRefresh />
                  <span>{isScanning ? t("device:actions.scanning") : t("device:page.actions.rescan")}</span>
                </Button>
              }
            />
          ) : supportedPorts.length > 0 ? (
            <div className="lm-device-grid">
              {supportedPorts.map((port) => {
                const connected = connectedPort === port.portName;
                const connecting = isConnecting && selectedPort === port.portName;
                return (
                  <SupportedPortCard
                    key={port.portName}
                    port={port}
                    connected={connected}
                    connecting={connecting}
                    busy={controllerBusy && !connecting}
                    healthChecking={connected && isHealthChecking}
                    onConnect={() => { void handleConnect(port.portName); }}
                    onHealthCheck={() => { void runHealthCheck(); }}
                  />
                );
              })}
            </div>
          ) : null}

          <OtherSerialPorts ports={otherPorts} />
        </div>
      </section>

      <UsbStripSettings localTransport={localSink?.transport ?? null} />

      <PairedStripsGroup
        pairedStrips={pairedStrips}
        setPairedStrips={setPairedStrips}
        supportedPorts={supportedPorts}
        connectedPort={connectedPort}
        persistError={persistError}
        flagPersistError={flagPersistError}
        clearPersistError={clearPersistError}
        onRescan={rescan}
        onAddConnected={() => {
          if (connectedPort) void addToRoster(connectedPort, connectedPort);
        }}
        addingConnected={addingToRoster}
        rosterSettling={connectInFlight}
        onNavigateToRoomMap={onNavigateToRoomMap}
      />
    </div>
  );
}
