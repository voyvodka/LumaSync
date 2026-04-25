/**
 * WledDevicePicker — v1.5 W1-B4
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
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  WLED_STATUS,
  type WledDeviceInfo,
} from "../../../shared/contracts/device";
import {
  connectWledSink,
  discoverWledDevices,
  testWledBridge,
  type WledCommandStatus,
} from "../../device/wledApi";

interface WledDevicePickerProps {
  /** Currently active sink reference (used to highlight the connected card). */
  activeWledIp?: string | null;
  /** Fired after a successful connect so the parent can persist the sink ref. */
  onConnected?: (device: WledDeviceInfo) => void;
}

type RowState =
  | { kind: "idle" }
  | { kind: "busy"; action: "connect" | "test" }
  | { kind: "result"; status: WledCommandStatus };

export function WledDevicePicker({
  activeWledIp = null,
  onConnected,
}: WledDevicePickerProps) {
  const { t } = useTranslation("common");
  const [manualIp, setManualIp] = useState("");
  const [manualIpError, setManualIpError] = useState<string | null>(null);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveryStatus, setDiscoveryStatus] =
    useState<WledCommandStatus | null>(null);
  const [devices, setDevices] = useState<WledDeviceInfo[]>([]);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});

  const validateManualIp = useCallback((value: string): string | null => {
    if (!value.trim()) return null; // blank = use mDNS scan
    // Permissive — accept dotted IPv4 or IPv6 textual.
    const v4 = /^(\d{1,3}\.){3}\d{1,3}$/;
    const v6 = /^[0-9a-fA-F:]+$/;
    if (!v4.test(value) && !v6.test(value)) {
      return t("devicesPage.wled.invalidIp");
    }
    return null;
  }, [t]);

  const handleDiscover = useCallback(async () => {
    const err = validateManualIp(manualIp);
    setManualIpError(err);
    if (err) return;
    setIsDiscovering(true);
    setDiscoveryStatus(null);
    try {
      const response = await discoverWledDevices(manualIp.trim() || undefined);
      setDiscoveryStatus(response.status);
      setDevices(response.devices ?? []);
    } catch (e) {
      console.error("[LumaSync] discoverWledDevices failed", e);
      setDiscoveryStatus({
        code: "WLED_DISCOVERY_FAILED",
        message: String(e),
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
        if (response.device && onConnected) {
          onConnected(response.device);
        }
      } catch (e) {
        console.error("[LumaSync] connectWledSink failed", e);
        setRowStates((prev) => ({
          ...prev,
          [device.ip]: {
            kind: "result",
            status: { code: "WLED_BRIDGE_UNREACHABLE", message: String(e) },
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
          status: { code: "WLED_BRIDGE_UNREACHABLE", message: String(e) },
        },
      }));
    }
  }, []);

  return (
    <div className="lm-device-cat-body">
      <div className="lm-device-head">
        <div>
          <h1>{t("devicesPage.wled.title")}</h1>
          <div className="lm-device-head-sub">
            {t("devicesPage.wled.subtitle")}
          </div>
        </div>
      </div>

      {/* Manual IP + discover row */}
      <div className="lm-hue-ip-form">
        <div>
          <div className="lm-hue-ip-form-title">
            {t("devicesPage.wled.manualIp")}
          </div>
          <div className="lm-hue-ip-form-sub">
            {t("devicesPage.wled.manualIpHint")}
          </div>
        </div>
        <div className="lm-hue-ip-row">
          <input
            type="text"
            inputMode="numeric"
            spellCheck={false}
            className="lm-hue-ip-input"
            value={manualIp}
            placeholder={t("devicesPage.wled.manualIpPlaceholder")}
            onChange={(e) => setManualIp(e.target.value)}
            aria-label={t("devicesPage.wled.manualIp")}
          />
          <button
            type="button"
            className="lm-hue-ip-submit"
            disabled={isDiscovering}
            aria-busy={isDiscovering}
            onClick={() => { void handleDiscover(); }}
          >
            {isDiscovering
              ? t("devicesPage.wled.discovering")
              : t("devicesPage.wled.discoverAction")}
          </button>
        </div>
        {manualIpError && <div className="lm-hue-ip-error">{manualIpError}</div>}
      </div>

      {/* Discovery result status */}
      {discoveryStatus && (
        <div
          role="status"
          aria-live="polite"
          className={[
            "mt-2 rounded border px-3 py-2 text-[11px]",
            discoveryStatus.code === WLED_STATUS.DISCOVERY_OK
              ? "border-emerald-500/40 bg-emerald-900/20 text-emerald-200"
              : discoveryStatus.code === WLED_STATUS.DISCOVERY_EMPTY
                ? "border-zinc-700 bg-zinc-800/40 text-zinc-300"
                : "border-rose-500/40 bg-rose-900/20 text-rose-200",
          ].join(" ")}
        >
          {translateWledStatusCode(discoveryStatus.code, t) ?? discoveryStatus.message}
        </div>
      )}

      {/* Device cards */}
      <div className="lm-device-grid mt-3">
        {devices.length === 0 && !isDiscovering && discoveryStatus && (
          <div className="lm-device-empty">
            <h3>{t("devicesPage.wled.empty.title")}</h3>
            <p>{t("devicesPage.wled.empty.body")}</p>
          </div>
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
                      <span className="lm-dcard-pill is-streaming">
                        {t("devicesPage.wled.pill.connected")}
                      </span>
                    ) : (
                      <span className="lm-dcard-pill is-warn">
                        {t("devicesPage.wled.pill.discovered")}
                      </span>
                    )}
                  </div>
                  <div className="lm-dcard-sub">{device.ip}</div>
                </div>
              </div>
              <div className="lm-dcard-body">
                <div className="lm-dcard-cell">
                  <div className="lm-dcard-cell-k">
                    {t("devicesPage.wled.cellLedCount")}
                  </div>
                  <div className="lm-dcard-cell-v">{device.ledCount}</div>
                </div>
                {device.version && (
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">
                      {t("devicesPage.wled.cellVersion")}
                    </div>
                    <div className="lm-dcard-cell-v">{device.version}</div>
                  </div>
                )}
                {device.mac && (
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">
                      {t("devicesPage.wled.cellMac")}
                    </div>
                    <div className="lm-dcard-cell-v">{device.mac}</div>
                  </div>
                )}
              </div>
              {/* Status note from the latest action */}
              {resultStatus && (
                <div
                  role="status"
                  aria-live="polite"
                  className={[
                    "rounded border px-2 py-1 text-[10px] mt-1",
                    resultStatus.code === "WLED_DISCOVERY_OK"
                      ? "border-emerald-500/40 bg-emerald-900/20 text-emerald-200"
                      : "border-amber-500/40 bg-amber-900/20 text-amber-200",
                  ].join(" ")}
                >
                  {translateWledStatusCode(resultStatus.code, t) ?? resultStatus.message}
                </div>
              )}
              <div className="lm-dcard-actions">
                <button
                  type="button"
                  className="lm-dcard-act"
                  disabled={isBusy}
                  aria-busy={isBusy && rowState.kind === "busy" && rowState.action === "connect"}
                  onClick={() => { void handleConnect(device); }}
                >
                  {rowState.kind === "busy" && rowState.action === "connect"
                    ? t("devicesPage.wled.connecting")
                    : isActive
                      ? t("devicesPage.wled.reconnectAction")
                      : t("devicesPage.wled.connectAction")}
                </button>
                <button
                  type="button"
                  className="lm-dcard-act"
                  disabled={isBusy}
                  aria-busy={isBusy && rowState.kind === "busy" && rowState.action === "test"}
                  onClick={() => { void handleTest(device); }}
                >
                  {rowState.kind === "busy" && rowState.action === "test"
                    ? t("devicesPage.wled.testing")
                    : t("devicesPage.wled.testAction")}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Map a `WLED_STATUS` code to its localized string, or null when unknown. */
function translateWledStatusCode(
  code: string,
  t: (key: string) => string,
): string | null {
  switch (code) {
    case WLED_STATUS.DISCOVERY_OK:
      return t("devicesPage.wled.status.discoveryOk");
    case WLED_STATUS.DISCOVERY_EMPTY:
      return t("devicesPage.wled.status.discoveryEmpty");
    case WLED_STATUS.DISCOVERY_TIMEOUT:
      return t("devicesPage.wled.status.discoveryTimeout");
    case WLED_STATUS.BRIDGE_UNREACHABLE:
      return t("devicesPage.wled.status.bridgeUnreachable");
    case WLED_STATUS.PROTOCOL_MISMATCH:
      return t("devicesPage.wled.status.protocolMismatch");
    case WLED_STATUS.LED_COUNT_MISMATCH:
      return t("devicesPage.wled.status.ledCountMismatch");
    default:
      return null;
  }
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
