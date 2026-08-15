import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";

import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import type { RoomMapConfig, UsbStripPlacement } from "@/shared/contracts/roomMap";
import { shellStore } from "@/features/persistence/shellStore";
import { buildDeviceStatusCard } from "@/features/device/deviceStatusCard";
import type { UseDeviceConnectionResult } from "@/features/device/useDeviceConnection";
import type { LedChipType } from "@/shared/contracts/device";
import { LedChipTypePicker } from "../control/LedChipTypePicker";
import { IconRefresh, IconUsb } from "@/shared/ui/icons";

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
  /** Inert when omitted — and then the picker only writes shellStore, leaving the
   *  running encoder on the boot-time byte width until the next reconnect. */
  onChipTypeChange?: (next: LedChipType) => void;
}

export function UsbStripsCategory({
  isActive,
  device,
  pairedStrips,
  setPairedStrips,
  persistError,
  flagPersistError,
  clearPersistError,
  onNavigateToRoomMap,
  onChipTypeChange,
}: UsbStripsCategoryProps) {
  const { t } = useTranslation();
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
  } = device;

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

  // The LED count persists between adds because segments are usually authored at
  // identical length. The dropdown offers any discovered port, not just the
  // connected one, so one surface covers pairing and multi-strip authoring.
  const [stripFormOpen, setStripFormOpen] = useState(false);
  const [stripDraftLedCount, setStripDraftLedCount] = useState("60");
  const [stripDraftPortName, setStripDraftPortName] = useState<string | null>(null);
  const [discoverPanelOpen, setDiscoverPanelOpen] = useState(false);
  // One card in edit mode at a time. The dropdown includes the strip's own
  // current port, or cancelling would leave the slot pointing at nothing.
  const [portEditStripId, setPortEditStripId] = useState<string | null>(null);
  const [portEditDraft, setPortEditDraft] = useState<string | null>(null);

  // One strip per controller: these are filtered out of the add dropdown.
  // Legacy strips with no `portName` occupy nothing and are fixed up from the
  // canvas when the user assigns a real port.
  const pairedPortNames = new Set(
    pairedStrips.map((s) => s.portName).filter((name): name is string => !!name),
  );
  const availablePortsForPairing = ports
    .map((p) => p.portName)
    .filter((name) => !pairedPortNames.has(name));

  // Rescan on open, or a device plugged in after first render never shows up.
  // Fire-and-forget so the form opens immediately; the hook logs its own errors
  // and a discovery hiccup must not block authoring.
  const handleOpenStripForm = useCallback(() => {
    setStripFormOpen(true);
    // Default the dropdown to the live connected port when it is still
    // available; otherwise fall back to the first unpaired discovery.
    const fallback =
      connectedPort && !pairedPortNames.has(connectedPort)
        ? connectedPort
        : availablePortsForPairing[0] ?? null;
    setStripDraftPortName(fallback);
    void refreshPorts();
  }, [connectedPort, availablePortsForPairing, pairedPortNames, refreshPorts]);

  // Seeded with the strip's current port so cancelling loses nothing, and
  // rescans so a newly plugged device is selectable.
  const handleOpenPortEditor = useCallback(
    (stripId: string, currentPort: string | null) => {
      setPortEditStripId(stripId);
      setPortEditDraft(currentPort);
      void refreshPorts();
    },
    [refreshPorts],
  );

  const handleClosePortEditor = useCallback(() => {
    setPortEditStripId(null);
    setPortEditDraft(null);
  }, []);

  // The duplicate-port guard is mandatory even though the dropdown filters
  // paired ports out: a stale selection from a concurrent edit still lands here.
  const handleSaveStripPort = useCallback(async () => {
    const targetId = portEditStripId;
    const nextPort = portEditDraft;
    if (!targetId || !nextPort) return;
    // Allow re-selecting the same port (no-op save).
    const target = pairedStrips.find((s) => s.stripId === targetId);
    if (!target) {
      handleClosePortEditor();
      return;
    }
    if (target.portName !== nextPort && pairedPortNames.has(nextPort)) {
      console.error("[LumaSync] handleSaveStripPort: port already paired", nextPort);
      flagPersistError();
      return;
    }
    if (target.portName === nextPort) {
      handleClosePortEditor();
      return;
    }
    try {
      const current = await shellStore.load();
      const currentRoomMap = current.roomMap ?? DEFAULT_ROOM_MAP;
      const updatedStrips = currentRoomMap.usbStrips.map((s) =>
        s.stripId === targetId ? { ...s, portName: nextPort } : s,
      );
      const updatedRoomMap: RoomMapConfig = {
        ...currentRoomMap,
        usbStrips: updatedStrips,
      };
      await shellStore.save({
        roomMap: updatedRoomMap,
        roomMapVersion: (current.roomMapVersion ?? 0) + 1,
      });
      setPairedStrips(updatedStrips);
      handleClosePortEditor();
      clearPersistError();
    } catch (e) {
      console.error("[LumaSync] handleSaveStripPort failed", e);
      flagPersistError();
    }
  }, [
    portEditStripId,
    portEditDraft,
    pairedStrips,
    pairedPortNames,
    handleClosePortEditor,
    setPairedStrips,
    flagPersistError,
    clearPersistError,
  ]);

  const handleAddStrip = useCallback(async () => {
    const portName = stripDraftPortName;
    if (!portName) return;
    if (pairedPortNames.has(portName)) {
      // Defensive — the dropdown filters paired ports out, but a stale
      // selection (e.g. another tab paired the port concurrently) must
      // still be rejected so we never write a duplicate slot.
      console.error("[LumaSync] handleAddStrip: port already paired", portName);
      flagPersistError();
      return;
    }
    const parsedCount = parseInt(stripDraftLedCount, 10);
    const ledCount = Number.isFinite(parsedCount)
      ? Math.max(1, Math.min(1000, parsedCount))
      : 60;
    try {
      const current = await shellStore.load();
      const currentRoomMap = current.roomMap ?? DEFAULT_ROOM_MAP;
      const widthM = currentRoomMap.dimensions?.widthMeters ?? DEFAULT_ROOM_MAP.dimensions.widthMeters;
      const newStrip: UsbStripPlacement = {
        stripId: `usb-${crypto.randomUUID()}`,
        startX: 1,
        startY: 1,
        endX: Math.max(2, widthM - 1),
        endY: 1,
        ledCount,
        portName,
      };
      const updatedRoomMap: RoomMapConfig = {
        ...currentRoomMap,
        usbStrips: [...currentRoomMap.usbStrips, newStrip],
      };
      await shellStore.save({
        roomMap: updatedRoomMap,
        roomMapVersion: (current.roomMapVersion ?? 0) + 1,
      });
      setPairedStrips(updatedRoomMap.usbStrips);
      setStripFormOpen(false);
      setStripDraftPortName(null);
      clearPersistError();
    } catch (e) {
      console.error("[LumaSync] handleAddStrip failed", e);
      flagPersistError();
    }
  }, [
    stripDraftPortName,
    stripDraftLedCount,
    pairedPortNames,
    setPairedStrips,
    flagPersistError,
    clearPersistError,
  ]);

  return (
    <div className={isActive ? "lm-device-cat-body" : "lm-device-cat-body hidden"} hidden={!isActive}>
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
          <button
            type="button"
            className="lm-device-btn"
            onClick={() => { void refreshPorts(); }}
            disabled={isScanning} aria-busy={isScanning}
          >
            <IconRefresh />
            <span>{isScanning ? t("device:actions.scanning") : t("device:page.actions.rescan")}</span>
          </button>
        </div>
      </div>

      {!isConnected && (
        <p className="text-[11px] text-zinc-500">{t("device:usbDisconnected")}</p>
      )}

      {/* W4-I #2 — "Discover ports" is now a collapsible utility,
          not the primary surface. The primary surface is the
          "Paired strips" list below; this section just lets the
          user inspect/connect a raw serial port when something is
          wrong. Default-closed so the page opens on the strip
          roster, not on a discovery list users would otherwise
          parse twice. */}
      <details
        className="lm-device-discover"
        open={discoverPanelOpen}
        onToggle={(e) => setDiscoverPanelOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="lm-device-discover-h">
          <span>{t("device:page.usb.discover.title")}</span>
          <span className="lm-device-discover-h-count">
            {ports.length === 1
              ? t("device:page.usb.discover.countOne")
              : t("device:page.usb.discover.count", { count: ports.length })}
          </span>
        </summary>
        <p className="lm-device-discover-hint">
          {t("device:page.usb.discover.hint")}
        </p>
      <div className="lm-device-grid">
        {ports.length === 0 ? (
          <div className="lm-device-empty">
            <h3>{t("device:page.usb.empty.title")}</h3>
            <p>{t("device:page.usb.empty.body")}</p>
          </div>
        ) : (
          ports.map((port) => {
            const isConnectedCard = connectedPort === port.portName;
            const isSelectedCard = selectedPort === port.portName && !isConnectedCard;
            const pillLabel = isConnectedCard
              ? t("device:page.usb.pill.online")
              : t("device:page.usb.pill.discovered");
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
                    <div className="lm-dcard-cell-k">{t("device:page.usb.stats.ledCount")}</div>
                    <div className="lm-dcard-cell-v">{t("device:page.usb.stats.na")}</div>
                  </div>
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("device:page.usb.stats.baud")}</div>
                    <div className="lm-dcard-cell-v">115200</div>
                  </div>
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("device:page.usb.stats.protocol")}</div>
                    <div className="lm-dcard-cell-v">LumaSync</div>
                  </div>
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("device:page.usb.stats.latency")}</div>
                    <div className={`lm-dcard-cell-v ${isConnectedCard ? "is-am" : ""}`}>
                      {t("device:page.usb.stats.na")}
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
                      disabled={healthActionDisabled} aria-busy={isHealthChecking}
                    >
                      {isHealthChecking ? t("device:healthCheck.runningAction") : t("device:healthCheck.runAction")}
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
                    disabled={isConnecting && isSelectedCard} aria-busy={isConnecting && isSelectedCard}
                  >
                    {isConnecting && isSelectedCard
                      ? t("device:actions.connecting")
                      : t("device:page.usb.pairAsStrip")}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
      </details>

      {/* Status card — preserved for diagnostics & test compatibility */}
      <div
        role="status"
        aria-live="polite"
        className={`lm-status-banner rounded-lg p-3 ${
          statusVariant === "success"
            ? "is-ok"
            : statusVariant === "error"
              ? "is-err"
              : "is-info"
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
                    {t(`device:healthCheck.steps.labels.${stepOutcome.step}`)}
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
                  {stepOutcome.pass ? t("device:healthCheck.steps.outcome.pass") : t("device:healthCheck.steps.outcome.fail")}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {statusCard?.code === "SELECTED_PORT_MISSING" ? (
          <p className="mt-1 text-[10px] text-zinc-500">
            {t("device:port.missingHint", { port: selectedPort ?? "-" })}
          </p>
        ) : null}
      </div>

      {/* Chip type selector — USB sink strip config (v1.5 G3) */}
      <LedChipTypePicker onChipTypeChange={onChipTypeChange} />

      {/* Paired strips — Wave 4-E + 4-G surface. Lists every
          persisted UsbStripPlacement with a per-strip portName,
          live ONLINE/OFFLINE chip, and a deep-link to the room-map
          editor. The W4-G "+ Add LED strip" CTA below allows
          authoring multiple segments per controller (multi-strip
          flow). */}
      <div className="lm-paired-strips">
        <div className="lm-paired-strips-h">
          <span>{t("device:page.usb.paired.title")}</span>
          <span className="lm-paired-strips-h-count">
            {pairedStrips.length === 1
              ? t("device:page.usb.paired.countOne")
              : t("device:page.usb.paired.count", { count: pairedStrips.length })}
          </span>
        </div>
        {pairedStrips.length === 0 ? (
          <div className="lm-paired-strips-empty">
            {t("device:page.usb.paired.empty")}
          </div>
        ) : (
          pairedStrips.map((strip) => {
            // Connected means this strip's own port is the live one. Legacy
            // strips with no `portName` keep the any-active-port heuristic
            // so existing maps do not lose their badge before a re-pair.
            const stripStatus: "connected" | "disconnected" =
              strip.portName
                ? strip.portName === connectedPort
                  ? "connected"
                  : "disconnected"
                : connectedPort
                  ? "connected"
                  : "disconnected";
            const portLabel = strip.portName ?? connectedPort ?? t("device:page.usb.paired.noPort");
            const isEditingPort = portEditStripId === strip.stripId;
            // Unpaired ports plus this strip's own, so re-selecting the same
            // one is a no-op rather than a missing option.
            const portEditOptions = isEditingPort
              ? Array.from(new Set([
                  ...(strip.portName ? [strip.portName] : []),
                  ...availablePortsForPairing,
                ]))
              : [];
            return (
              <div key={strip.stripId} className="lm-paired-strip">
                <div className="lm-paired-strip-ic"><IconUsb /></div>
                <div className="lm-paired-strip-tx">
                  <div className="lm-paired-strip-name">
                    {t("device:page.usb.paired.stripName", { count: strip.ledCount })}
                  </div>
                  {isEditingPort ? (
                    <div className="lm-paired-strip-port-editor">
                      <select
                        className="lm-paired-strip-form-select"
                        value={portEditDraft ?? ""}
                        onChange={(e) => setPortEditDraft(e.target.value || null)}
                        aria-label={t("device:page.usb.paired.portLabel")}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleSaveStripPort();
                          } else if (e.key === "Escape") {
                            handleClosePortEditor();
                          }
                        }}
                      >
                        {portEditOptions.length === 0 ? (
                          <option value="" disabled>
                            {t("device:page.usb.paired.formEmptyAllPaired")}
                          </option>
                        ) : (
                          portEditOptions.map((portName) => {
                            const port = ports.find((p) => p.portName === portName);
                            const display = port
                              ? portDisplayName(port.portName, port.product, port.manufacturer)
                              : portName;
                            return (
                              <option key={portName} value={portName}>
                                {display === portName ? portName : `${display} (${portName})`}
                              </option>
                            );
                          })
                        )}
                      </select>
                    </div>
                  ) : (
                    <div className="lm-paired-strip-sub">
                      {portLabel}
                    </div>
                  )}
                </div>
                {!isEditingPort ? (
                  <span
                    className={`lm-room-dock-conn-chip lm-room-dock-conn-chip--${stripStatus}`}
                    role="status"
                    aria-live="polite"
                  >
                    <span className="lm-room-dock-conn-chip-dot" aria-hidden />
                    <span className="lm-room-dock-conn-chip-tx">
                      {stripStatus === "connected"
                        ? t("device:page.usb.pill.online")
                        : t("device:page.usb.paired.offline")}
                    </span>
                  </span>
                ) : null}
                {isEditingPort ? (
                  <>
                    <button
                      type="button"
                      className="lm-paired-strip-action"
                      onClick={handleClosePortEditor}
                    >
                      {t("device:page.usb.paired.changePortCancel")}
                    </button>
                    <button
                      type="button"
                      className="lm-paired-strip-action is-primary"
                      onClick={() => { void handleSaveStripPort(); }}
                      disabled={!portEditDraft}
                    >
                      {t("device:page.usb.paired.changePortConfirm")}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="lm-paired-strip-action"
                      onClick={() => handleOpenPortEditor(strip.stripId, strip.portName ?? null)}
                      aria-label={t("device:page.usb.paired.changePortAriaLabel")}
                      title={t("device:page.usb.paired.changePortAriaLabel")}
                    >
                      {t("device:page.usb.paired.changePort")}
                    </button>
                    {onNavigateToRoomMap ? (
                      <button
                        type="button"
                        className="lm-paired-strip-action"
                        onClick={onNavigateToRoomMap}
                      >
                        {t("device:page.usb.paired.openInMap")}
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            );
          })
        )}

        {/* W4-I #2 — "+ Add LED strip" CTA. Drives a port dropdown
            (any unpaired discovered port is eligible) + LED count
            input. W4-J #1: opening the form fires a fresh
            `list_serial_ports` invoke, and the dropdown stays open
            even when the available-port list is momentarily empty
            (e.g. user opens with one device, plugs / unplugs
            between renders) so the empty state can render an
            inline rescan affordance instead of silently collapsing
            back to the disabled add-button. The dropdown options
            are re-filtered against `pairedPortNames` at render time
            — defensive against any race where `availablePortsFor-
            Pairing` is computed against a stale snapshot. */}
        {stripFormOpen ? (
          <div className="lm-paired-strip-form">
            {availablePortsForPairing.length === 0 ? (
              <>
                <span className="lm-paired-strip-form-empty">
                  {ports.length === 0
                    ? t("device:page.usb.paired.formEmptyNoPorts")
                    : t("device:page.usb.paired.formEmptyAllPaired")}
                </span>
                <div className="lm-paired-strip-form-actions">
                  <button
                    type="button"
                    className="lm-paired-strip-action"
                    onClick={() => setStripFormOpen(false)}
                  >
                    {t("device:page.usb.paired.cancel")}
                  </button>
                  <button
                    type="button"
                    className="lm-paired-strip-action is-primary"
                    onClick={() => { void refreshPorts(); }}
                    disabled={isScanning} aria-busy={isScanning}
                  >
                    {isScanning
                      ? t("device:actions.scanning")
                      : t("device:page.usb.paired.rescan")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <label
                  className="lm-paired-strip-form-label"
                  htmlFor="paired-strip-port-select"
                >
                  {t("device:page.usb.paired.portLabel")}
                </label>
                <select
                  id="paired-strip-port-select"
                  className="lm-paired-strip-form-select"
                  value={stripDraftPortName ?? ""}
                  onChange={(e) => setStripDraftPortName(e.target.value || null)}
                  aria-label={t("device:page.usb.paired.portLabel")}
                >
                  {availablePortsForPairing
                    .filter((portName) => !pairedPortNames.has(portName))
                    .map((portName) => {
                      const port = ports.find((p) => p.portName === portName);
                      const display = port
                        ? portDisplayName(port.portName, port.product, port.manufacturer)
                        : portName;
                      return (
                        <option key={portName} value={portName}>
                          {display === portName ? portName : `${display} (${portName})`}
                        </option>
                      );
                    })}
                </select>
                <label
                  className="lm-paired-strip-form-label"
                  htmlFor="paired-strip-led-count"
                >
                  {t("device:page.usb.paired.ledCountLabel")}
                </label>
                <input
                  id="paired-strip-led-count"
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  inputMode="numeric"
                  className="lm-paired-strip-form-input"
                  value={stripDraftLedCount}
                  onChange={(e) => setStripDraftLedCount(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleAddStrip();
                    } else if (e.key === "Escape") {
                      setStripFormOpen(false);
                    }
                  }}
                  autoFocus
                />
                <div className="lm-paired-strip-form-actions">
                  <button
                    type="button"
                    className="lm-paired-strip-action"
                    onClick={() => { void refreshPorts(); }}
                    title={t("device:page.usb.paired.rescan")}
                    aria-label={t("device:page.usb.paired.rescan")}
                    disabled={isScanning} aria-busy={isScanning}
                  >
                    {isScanning ? "…" : "↻"}
                  </button>
                  <button
                    type="button"
                    className="lm-paired-strip-action"
                    onClick={() => setStripFormOpen(false)}
                  >
                    {t("device:page.usb.paired.cancel")}
                  </button>
                  <button
                    type="button"
                    className="lm-paired-strip-action is-primary"
                    onClick={() => { void handleAddStrip(); }}
                    disabled={!stripDraftPortName}
                  >
                    {t("device:page.usb.paired.confirmAdd")}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="lm-paired-strip-add"
            onClick={handleOpenStripForm}
            disabled={availablePortsForPairing.length === 0}
            title={
              availablePortsForPairing.length === 0
                ? ports.length === 0
                  ? t("device:page.usb.paired.addDisabledNoPortsTooltip")
                  : t("device:page.usb.paired.addDisabledAllPairedTooltip")
                : undefined
            }
          >
            {pairedStrips.length === 0
              ? t("device:page.usb.paired.addFirst")
              : t("device:page.usb.paired.addAnother")}
          </button>
        )}

        {persistError ? (
          <div className="lm-paired-strips-empty" role="status" aria-live="polite">
            {t("device:page.usb.paired.persistError")}
          </div>
        ) : null}
      </div>

    </div>
  );
}
