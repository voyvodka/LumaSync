/**
 * WledDevicePicker
 *
 * Network-LED picker rendered inside the Devices section. Mirrors the
 * USB cards/discovery flow but talks to the WLED UDP contract:
 *
 *   - Manual IP input + Discover → `discover_wled_devices`
 *   - Per-device "Connect" → `connect_wled_sink` (binds the active sink)
 *   - Per-device "Test" → `test_wled_bridge` (single red-ramp frame)
 *
 * Status codes from `WLED_STATUS` map to localized strings under
 * `devicesPage.wled.status.*` so the UI never leaks raw constants.
 *
 * A11y:
 *   - Each card is a row with `role="group"`; actions are real buttons
 *     with amber focus ring and ≥ 32 px tap floor.
 *   - The discover button has an `aria-busy` state during the scan.
 *   - Errors / status notes use `role="status"` + `aria-live="polite"`
 *     so screen readers announce result changes.
 */
import { useCallback, useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import {
  WLED_STATUS,
  type WledDeviceInfo,
  type WledStatusCode,
  type WledUdpSinkConfig,
} from "@/shared/contracts/device";
import {
  connectWledSink,
  discoverWledDevices,
  testWledBridge,
  type WledCommandStatus,
} from "@/features/device/wledApi";
import type { WledRestoreOutcome } from "@/features/device/wledSinkRestore";
import type { TranslationKey } from "@/features/i18n/catalogue";
import { parseCommandError } from "@/shared/contracts/status";
import { Button } from "@/shared/ui/Button";
import { Callout, type CalloutTone } from "@/shared/ui/Callout";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusPill } from "@/shared/ui/StatusPill";

interface WledDevicePickerProps {
  /** Currently active sink reference (used to highlight the connected card). */
  activeWledIp?: string | null;
  /** Persisted restore intent — outlives a failed restore, so the saved IP can be offered back. */
  savedSink?: WledUdpSinkConfig | null;
  /** Outcome of the boot-time restore, rendered so an unreachable device is never silent. */
  restoreOutcome?: WledRestoreOutcome;
  /** Fired after a successful connect so the parent can persist the sink ref. */
  onConnected?: (device: WledDeviceInfo) => void;
}

type RowState =
  | { kind: "idle" }
  | { kind: "busy"; action: "connect" | "test" }
  | { kind: "result"; status: WledCommandStatus };

export function WledDevicePicker({
  activeWledIp = null,
  savedSink = null,
  restoreOutcome = { kind: "idle" },
  onConnected,
}: WledDevicePickerProps) {
  const { t } = useTranslation();
  const [manualIp, setManualIp] = useState("");
  const [manualIpError, setManualIpError] = useState<string | null>(null);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveryStatus, setDiscoveryStatus] =
    useState<WledCommandStatus | null>(null);
  const [devices, setDevices] = useState<WledDeviceInfo[]>([]);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [ipPrefilled, setIpPrefilled] = useState(false);

  // A failed restore should cost one click to retry, not a re-typed IP.
  // Fires once and never overwrites what the user has already entered.
  useEffect(() => {
    if (ipPrefilled || !savedSink) return;
    setIpPrefilled(true);
    setManualIp((current) => (current.length > 0 ? current : savedSink.ip));
  }, [ipPrefilled, savedSink]);

  const validateManualIp = useCallback((value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return t("device:page.wled.ipRequired");
    // Permissive — accept dotted IPv4 or IPv6 textual.
    const v4 = /^(\d{1,3}\.){3}\d{1,3}$/;
    const v6 = /^[0-9a-fA-F:]+$/;
    if (!v4.test(trimmed) && !v6.test(trimmed)) {
      return t("device:page.wled.invalidIp");
    }
    return null;
  }, [t]);

  const handleDiscover = useCallback(async () => {
    const trimmed = manualIp.trim();
    const err = validateManualIp(manualIp);
    setManualIpError(err);
    if (err) return;
    setIsDiscovering(true);
    setDiscoveryStatus(null);
    try {
      const response = await discoverWledDevices(trimmed);
      setDiscoveryStatus(response.status);
      setDevices(response.devices ?? []);
    } catch (e) {
      console.error("[LumaSync] discoverWledDevices failed", e);
      setDiscoveryStatus({
        code: WLED_STATUS.DISCOVERY_UNREACHABLE,
        message: parseCommandError(e).message,
        details: null,
      });
    } finally {
      setIsDiscovering(false);
    }
  }, [manualIp, validateManualIp]);

  const handleConnect = useCallback(
    async (device: WledDeviceInfo) => {
      setRowStates((prev) => ({
        ...prev,
        [device.ip]: { kind: "busy", action: "connect" },
      }));
      try {
        const response = await connectWledSink(device);
        setRowStates((prev) => ({
          ...prev,
          [device.ip]: { kind: "result", status: response.status },
        }));
        if (response.status.code === WLED_STATUS.CONNECT_OK && onConnected) {
          onConnected(device);
        }
      } catch (e) {
        console.error("[LumaSync] connectWledSink failed", e);
        setRowStates((prev) => ({
          ...prev,
          [device.ip]: {
            kind: "result",
            status: {
              code: WLED_STATUS.BRIDGE_UNREACHABLE,
              message: parseCommandError(e).message,
              details: null,
            },
          },
        }));
      }
    },
    [onConnected],
  );

  const handleTest = useCallback(async (device: WledDeviceInfo) => {
    setRowStates((prev) => ({
      ...prev,
      [device.ip]: { kind: "busy", action: "test" },
    }));
    try {
      const response = await testWledBridge(device);
      setRowStates((prev) => ({
        ...prev,
        [device.ip]: { kind: "result", status: response.status },
      }));
    } catch (e) {
      console.error("[LumaSync] testWledBridge failed", e);
      setRowStates((prev) => ({
        ...prev,
        [device.ip]: {
          kind: "result",
          status: {
              code: WLED_STATUS.BRIDGE_UNREACHABLE,
              message: parseCommandError(e).message,
              details: null,
            },
        },
      }));
    }
  }, []);

  return (
    <div className="lm-device-cat-body">
      <div className="lm-device-head">
        <div>
          <h1>{t("device:page.wled.title")}</h1>
          <div className="lm-device-head-sub">
            {t("device:page.wled.subtitle")}
          </div>
        </div>
      </div>

      <WledRestoreBanner outcome={restoreOutcome} t={t} />

      {/* Manual IP + discover row */}
      <div className="lm-hue-ip-form">
        <div>
          <div className="lm-hue-ip-form-title">
            {t("device:page.wled.manualIp")}
          </div>
          <div className="lm-hue-ip-form-sub">
            {t("device:page.wled.manualIpHint")}
          </div>
        </div>
        <div className="lm-hue-ip-row">
          <input
            type="text"
            inputMode="numeric"
            spellCheck={false}
            className="lm-hue-ip-input"
            value={manualIp}
            placeholder={t("device:page.wled.manualIpPlaceholder")}
            onChange={(e) => setManualIp(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isDiscovering) {
                e.preventDefault();
                void handleDiscover();
              }
            }}
            aria-label={t("device:page.wled.manualIp")}
          />
          <button
            type="button"
            className="lm-hue-ip-submit"
            disabled={isDiscovering || !manualIp.trim()}
            aria-busy={isDiscovering}
            onClick={() => { void handleDiscover(); }}
          >
            {isDiscovering
              ? t("device:page.wled.discovering")
              : t("device:page.wled.discoverAction")}
          </button>
        </div>
        {manualIpError && <div className="lm-hue-ip-error">{manualIpError}</div>}
      </div>

      {/* Discovery result status */}
      {discoveryStatus && (
        <Callout tone={wledStatusTone(discoveryStatus.code)}>
          {translateWledStatusCode(discoveryStatus.code, t) ?? discoveryStatus.message}
        </Callout>
      )}

      {/* Device cards */}
      <div className="lm-device-grid">
        {devices.length === 0 && !isDiscovering && discoveryStatus && (
          <EmptyState
            title={t("device:page.wled.empty.title")}
            body={t("device:page.wled.empty.body")}
          />
        )}
        {devices.map((device) => {
          const rowState = rowStates[device.ip] ?? ({ kind: "idle" } as RowState);
          const isActive = activeWledIp === device.ip;
          const cardCls = isActive ? "lm-dcard is-on" : "lm-dcard is-ghost";
          const isBusy = rowState.kind === "busy";
          const resultStatus =
            rowState.kind === "result" ? rowState.status : null;
          return (
            <div
              key={device.ip}
              role="group"
              aria-label={device.name ?? device.ip}
              className={cardCls}
            >
              <div className="lm-dcard-head">
                <div className="lm-dcard-ic">
                  <WledIcon />
                </div>
                <div className="lm-dcard-tx">
                  <div className="lm-dcard-name">
                    <span>{device.name ?? device.ip}</span>
                    {isActive ? (
                      <StatusPill tone="streaming">
                        {t("device:page.wled.pill.connected")}
                      </StatusPill>
                    ) : (
                      <StatusPill tone="warn">
                        {t("device:page.wled.pill.discovered")}
                      </StatusPill>
                    )}
                  </div>
                  <div className="lm-dcard-sub">{device.ip}</div>
                </div>
              </div>
              <div className="lm-dcard-body">
                <div className="lm-dcard-cell">
                  <div className="lm-dcard-cell-k">
                    {t("device:page.wled.cellLedCount")}
                  </div>
                  <div className="lm-dcard-cell-v">{device.ledCount}</div>
                </div>
                {device.version && (
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">
                      {t("device:page.wled.cellVersion")}
                    </div>
                    <div className="lm-dcard-cell-v">{device.version}</div>
                  </div>
                )}
                {device.mac && (
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">
                      {t("device:page.wled.cellMac")}
                    </div>
                    <div className="lm-dcard-cell-v">{device.mac}</div>
                  </div>
                )}
              </div>
              {/* Status note from the latest action */}
              {resultStatus && (
                <Callout tone={wledStatusTone(resultStatus.code)} className="mt-1">
                  {translateWledStatusCode(resultStatus.code, t) ?? resultStatus.message}
                </Callout>
              )}
              <div className="lm-dcard-actions">
                <Button
                  size="card"
                  disabled={isBusy}
                  busy={rowState.kind === "busy" && rowState.action === "connect"}
                  onClick={() => { void handleConnect(device); }}
                >
                  {rowState.kind === "busy" && rowState.action === "connect"
                    ? t("device:page.wled.connecting")
                    : isActive
                      ? t("device:page.wled.reconnectAction")
                      : t("device:page.wled.connectAction")}
                </Button>
                <Button
                  size="card"
                  disabled={isBusy}
                  busy={rowState.kind === "busy" && rowState.action === "test"}
                  onClick={() => { void handleTest(device); }}
                >
                  {rowState.kind === "busy" && rowState.action === "test"
                    ? t("device:page.wled.testing")
                    : t("device:page.wled.testAction")}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Reports the boot restore. A saved device that never came back must say so here — nothing else in the UI would. */
function WledRestoreBanner({
  outcome,
  t,
}: {
  outcome: WledRestoreOutcome;
  t: TFunction;
}) {
  if (outcome.kind === "idle" || outcome.kind === "no-saved-device") return null;

  const tone: CalloutTone =
    outcome.kind === "failed" ? "error" : outcome.kind === "restored" ? "ok" : "info";

  // Keep every `t()` call out of a template literal — the i18n orphan
  // verifier consumes a backtick literal whole and never sees a key inside it.
  const headline =
    outcome.kind === "restoring"
      ? t("device:page.wled.restore.restoring", { ip: outcome.sink.ip })
      : outcome.kind === "restored"
        ? t("device:page.wled.restore.restored", { ip: outcome.sink.ip })
        : t("device:page.wled.restore.failed", { ip: outcome.sink.ip });

  const reason =
    outcome.kind === "failed"
      ? translateWledStatusCode(outcome.status.code, t) ?? outcome.status.message
      : null;

  return (
    <Callout tone={tone}>
      {headline}
      {reason ? " " + reason : null}
    </Callout>
  );
}

/** Every code a WLED command can answer with, in the user's words. A
 *  `Record` over the whole union so a new code cannot ship untranslated. */
export const WLED_STATUS_COPY = {
  [WLED_STATUS.DISCOVERY_OK]: "device:page.wled.status.discoveryOk",
  [WLED_STATUS.DISCOVERY_TIMEOUT]: "device:page.wled.status.discoveryTimeout",
  [WLED_STATUS.DISCOVERY_UNREACHABLE]: "device:page.wled.status.discoveryUnreachable",
  [WLED_STATUS.BRIDGE_UNREACHABLE]: "device:page.wled.status.bridgeUnreachable",
  [WLED_STATUS.PROTOCOL_MISMATCH]: "device:page.wled.status.protocolMismatch",
  [WLED_STATUS.LED_COUNT_MISMATCH]: "device:page.wled.status.ledCountMismatch",
  [WLED_STATUS.INVALID_IP]: "device:page.wled.status.invalidIp",
  [WLED_STATUS.INVALID_LED_COUNT]: "device:page.wled.status.invalidLedCount",
  [WLED_STATUS.CONNECT_OK]: "device:page.wled.status.connectOk",
  [WLED_STATUS.TEST_LIVE_CONFIRMED]: "device:page.wled.status.testLiveConfirmed",
  [WLED_STATUS.TEST_SENT_UNCONFIRMED]: "device:page.wled.status.testSentUnconfirmed",
  [WLED_STATUS.REALTIME_PORT_MISMATCH]: "device:page.wled.status.realtimePortMismatch",
  [WLED_STATUS.LIVE_LED_COUNT_MISMATCH]: "device:page.wled.status.ledCountMismatch",
  [WLED_STATUS.TEST_SEND_FAILED]: "device:page.wled.status.testSendFailed",
  [WLED_STATUS.CLIENT_BUILD_FAILED]: "device:page.wled.status.clientBuildFailed",
  [WLED_STATUS.SINK_NOT_STARTED]: "device:page.wled.status.sinkNotStarted",
  [WLED_STATUS.DISCOVERY_WORKER_FAILED]: "device:page.wled.status.workerFailed",
  [WLED_STATUS.TEST_WORKER_FAILED]: "device:page.wled.status.workerFailed",
  [WLED_STATUS.CONNECT_WORKER_FAILED]: "device:page.wled.status.workerFailed",
} as const satisfies Record<WledStatusCode, TranslationKey>;

/** A success reads as one, a caveat as a warning, anything that stopped the
 *  action as an error — every non-discovery answer used to be a warning. */
export function wledStatusTone(code: string): CalloutTone {
  switch (code) {
    case WLED_STATUS.DISCOVERY_OK:
    case WLED_STATUS.CONNECT_OK:
    case WLED_STATUS.TEST_LIVE_CONFIRMED:
      return "ok";
    case WLED_STATUS.TEST_SENT_UNCONFIRMED:
    case WLED_STATUS.LED_COUNT_MISMATCH:
    case WLED_STATUS.LIVE_LED_COUNT_MISMATCH:
      return "warning";
    default:
      return "error";
  }
}

function translateWledStatusCode(
  code: string,
  t: TFunction,
): string | null {
  return Object.prototype.hasOwnProperty.call(WLED_STATUS_COPY, code)
    ? t(WLED_STATUS_COPY[code as WledStatusCode])
    : null;
}

function WledIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 8c5 5 15 5 20 0" />
      <path d="M5 12c3.5 3.5 10.5 3.5 14 0" />
      <path d="M8 16c2 2 6 2 8 0" />
      <circle cx="12" cy="20" r="1" fill="currentColor" />
    </svg>
  );
}
