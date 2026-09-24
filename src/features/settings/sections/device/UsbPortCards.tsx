import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { DevicePort } from "@/features/device/types";
import { Button } from "@/shared/ui/Button";
import { cx } from "@/shared/ui/cx";
import { IconUsb } from "@/shared/ui/icons";
import { StatusPill } from "@/shared/ui/StatusPill";

export function portDisplayName(port: Pick<DevicePort, "portName" | "product" | "manufacturer">): string {
  const { portName, product, manufacturer } = port;
  if (product && manufacturer) return `${manufacturer} ${product}`;
  return product ?? manufacturer ?? portName;
}

function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

/** `VID:PID`, the only identity every adapter reports. */
export function usbId(port: Pick<DevicePort, "vid" | "pid">): string | null {
  return port.vid === undefined || port.pid === undefined ? null : `${hex4(port.vid)}:${hex4(port.pid)}`;
}

interface SupportedPortCardProps {
  port: DevicePort;
  connected: boolean;
  /** This card's own connect is running. */
  connecting: boolean;
  /** Another operation holds the controller. */
  busy: boolean;
  healthChecking: boolean;
  onConnect: () => void;
  onHealthCheck: () => void;
}

export function SupportedPortCard({
  port,
  connected,
  connecting,
  busy,
  healthChecking,
  onConnect,
  onHealthCheck,
}: SupportedPortCardProps) {
  const { t } = useTranslation();
  const name = portDisplayName(port);
  const id = usbId(port);
  return (
    <div
      role="group"
      aria-label={name}
      className={cx("lm-dcard", connected && "is-on")}
      data-testid="usb-port-card"
      data-port={port.portName}
    >
      <div className="lm-dcard-head">
        <div className="lm-dcard-ic"><IconUsb /></div>
        <div className="lm-dcard-tx">
          <div className="lm-dcard-name">
            <span>{name}</span>
            {connected ? (
              <StatusPill tone="ok">{t("device:page.usb.pill.online")}</StatusPill>
            ) : (
              <StatusPill tone="idle">{t("device:page.usb.pill.ready")}</StatusPill>
            )}
          </div>
          {name !== port.portName ? <div className="lm-dcard-sub">{port.portName}</div> : null}
        </div>
      </div>

      <div className="lm-dcard-body">
        <div className="lm-dcard-cell">
          <div className="lm-dcard-cell-k">{t("device:page.usb.stats.usbId")}</div>
          <div className="lm-dcard-cell-v">{id ?? t("device:page.usb.stats.na")}</div>
        </div>
        <div className="lm-dcard-cell">
          <div className="lm-dcard-cell-k">{t("device:page.usb.stats.state")}</div>
          <div className={cx("lm-dcard-cell-v", connected ? "is-ok" : "is-dim")}>
            {connected ? t("device:page.usb.stats.connected") : t("device:page.usb.stats.notConnected")}
          </div>
        </div>
      </div>

      <div className="lm-dcard-actions">
        {connected ? (
          <Button size="card" onClick={onHealthCheck} disabled={busy} busy={healthChecking}>
            {healthChecking ? t("device:healthCheck.runningAction") : t("device:healthCheck.runAction")}
          </Button>
        ) : (
          <Button size="card" variant="primary" onClick={onConnect} disabled={busy} busy={connecting}>
            {connecting ? t("device:actions.connecting") : t("device:page.usb.connect")}
          </Button>
        )}
      </div>
    </div>
  );
}

interface OtherPortsProps {
  ports: DevicePort[];
}

/**
 * Ports that enumerate but fail the VID/PID allowlist — a Bluetooth serial
 * port, a debug console. Listed so the user can see the app found them, and
 * collapsed because none of them can ever be a strip.
 */
export function OtherSerialPorts({ ports }: OtherPortsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (ports.length === 0) return null;
  return (
    <details
      className="lm-usb-other"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      data-testid="usb-other-ports"
    >
      <summary className="lm-usb-other-h">
        <span>{t("device:page.usb.other.title")}</span>
        <span className="lm-usb-other-count">{t("device:page.usb.other.count", { count: ports.length })}</span>
      </summary>
      <div className="lm-usb-other-body">
        <p className="lm-usb-other-hint">{t("device:page.usb.other.hint")}</p>
        <div className="lm-device-grid">
          {ports.map((port) => {
            const name = portDisplayName(port);
            const sub = [name !== port.portName ? port.portName : null, usbId(port)].filter(Boolean).join(" · ");
            return (
              <div
                key={port.portName}
                role="group"
                aria-label={name}
                className="lm-dcard is-ghost"
                data-testid="usb-other-port-card"
              >
                <div className="lm-dcard-head">
                  <div className="lm-dcard-ic"><IconUsb /></div>
                  <div className="lm-dcard-tx">
                    <div className="lm-dcard-name">
                      <span>{name}</span>
                      <StatusPill tone="idle">{t("device:page.usb.pill.unsupported")}</StatusPill>
                    </div>
                    {sub ? <div className="lm-dcard-sub">{sub}</div> : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </details>
  );
}
