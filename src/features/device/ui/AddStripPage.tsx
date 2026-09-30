import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { WledDeviceInfo } from "@/shared/contracts/device";
import { Reveal } from "@/shared/ui/Reveal/Reveal";
import { RevealList } from "@/shared/ui/Reveal/RevealList";
import { RowButton, RowNote, SettingRow } from "@/shared/ui/SettingRow/SettingRow";
import { StateSwap } from "@/shared/ui/StateSwap/StateSwap";

import { shortPortName } from "../model/deviceRail";
import { useWledBrowse } from "../state/useWledBrowse";
import type { DevicePort } from "../types";
import type { UseDeviceConnectionResult } from "../useDeviceConnection";
import { FoundPortRow, FoundWledRow, WledAddressRow, type AddedOutput } from "./AddStripRows";
import pageStyles from "@/shared/ui/SettingRow/SettingPage.module.css";
import styles from "./StripPage.module.css";

interface AddStripPageProps {
  isActive: boolean;
  /** "Add a strip", or the name of a strip that has lost its controller. */
  title: string;
  /** Supported ports plugged in that no strip is on. */
  ports: readonly DevicePort[];
  /** Serial ports that are not on the supported list: named, never offered. */
  otherPorts: readonly DevicePort[];
  device: UseDeviceConnectionResult;
  onWledBound: (device: WledDeviceInfo) => Promise<void>;
  /** The WLED device already added: the browse does not offer it again. */
  boundWledIp: string | null;
  /** The strip adding one moves: one strip is driven at a time for now. */
  replaces: string | null;
  onAdded: (added: AddedOutput) => void;
}

/**
 * Adding a strip: a controller plugged in, listed as it appears, a WLED device found on the network,
 * or one by address.
 */
export function AddStripPage({
  isActive,
  title,
  ports,
  otherPorts,
  device,
  onWledBound,
  boundWledIp,
  replaces,
  onAdded,
}: AddStripPageProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const browse = useWledBrowse(isActive);
  const found = browse.devices.filter((wled) => wled.ip !== boundWledIp);
  // Which WLED rows are adding, by row: one add at a time across the page.
  const [wledBusy, setWledBusy] = useState<ReadonlySet<string>>(() => new Set());
  // One callback per row for good: a row's effect runs again whenever its callback changes.
  const busyCallbacks = useRef(new Map<string, (busy: boolean) => void>());
  const busyFor = (key: string) => {
    let callback = busyCallbacks.current.get(key);
    if (!callback) {
      callback = (busy: boolean) =>
        setWledBusy((current) => {
          if (current.has(key) === busy) return current;
          const next = new Set(current);
          if (busy) next.add(key);
          else next.delete(key);
          return next;
        });
      busyCallbacks.current.set(key, callback);
    }
    return callback;
  };
  const wledBlocked = (key: string) => device.isConnecting || [...wledBusy].some((busy) => busy !== key);
  return (
    <section className={pageStyles.page} hidden={!isActive} aria-labelledby={headingId} data-testid="add-strip-page">
      <h1 id={headingId} className={styles.heading}>
        {title}
      </h1>
      {replaces !== null ? (
        <RowNote tone="status" testId="add-strip-replaces">{t("device:strip.add.replaces", { name: replaces })}</RowNote>
      ) : null}
      <div className={pageStyles.rows}>
        <Reveal open={ports.length === 0}>
          <SettingRow label={t("device:strip.add.usb")} value={t("device:strip.add.usbNone")} testId="add-strip-usb" />
        </Reveal>
        <RevealList items={ports} keyOf={(port) => port.portName}>
          {(port) => (
            <FoundPortRow port={port} device={device} primary={ports.length === 1} blocked={wledBusy.size > 0} onAdded={onAdded} />
          )}
        </RevealList>
        <Reveal open={browse.browsing && found.length === 0}>
          <SettingRow
            label={t("device:strip.add.network")}
            value={t("device:strip.add.searching")}
            testId="wled-browse-searching"
          />
        </Reveal>
        <RevealList items={found} keyOf={(wled) => wled.ip}>
          {(wled) => (
            <FoundWledRow
              found={wled}
              onBound={onWledBound}
              onAdded={onAdded}
              primary={ports.length === 0 && found.length === 1}
              blocked={wledBlocked(wled.ip)}
              onBusyChange={busyFor(wled.ip)}
            />
          )}
        </RevealList>
        <Reveal open>
          <WledAddressRow
            onBound={onWledBound}
            onAdded={onAdded}
            primary={ports.length === 0 && found.length === 0}
            blocked={wledBlocked("address")}
            onBusyChange={busyFor("address")}
          />
        </Reveal>
        <Reveal open={otherPorts.length > 0}>
          <OtherPortsRow ports={otherPorts} />
        </Reveal>
      </div>
    </section>
  );
}

interface FoundPortPageProps {
  isActive: boolean;
  port: DevicePort;
  device: UseDeviceConnectionResult;
  replaces: string | null;
  onAdded: (added: AddedOutput) => void;
}

/** A controller plugged in and not added: Add is the one thing to do. */
export function FoundPortPage({ isActive, port, device, replaces, onAdded }: FoundPortPageProps) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section className={pageStyles.page} hidden={!isActive} aria-labelledby={headingId} data-testid="found-port-page">
      <h1 id={headingId} className={styles.heading}>
        {port.product ?? port.portName}
      </h1>
      <div className={pageStyles.rows}>
        <Reveal open>
          <FoundPortRow
            port={port}
            device={device}
            label={t("device:strip.row.controller")}
            primary
            note={replaces !== null ? <RowNote tone="status">{t("device:strip.add.replaces", { name: replaces })}</RowNote> : null}
            onAdded={onAdded}
          />
        </Reveal>
      </div>
    </section>
  );
}

/** Ports LumaSync will not open, folded: they explain an empty list without inviting a click. */
function OtherPortsRow({ ports }: { ports: readonly DevicePort[] }) {
  const { t } = useTranslation();
  const listId = useId();
  const [open, setOpen] = useState(false);
  return (
    <SettingRow
      label={t("device:strip.add.otherPorts")}
      hint={t("device:strip.add.otherPortsHint")}
      value={String(ports.length)}
      testId="add-strip-other-ports"
      control={
        <RowButton aria-expanded={open} aria-controls={listId} onClick={() => setOpen((shown) => !shown)}>
          <StateSwap
            fit
            state={open ? "hide" : "show"}
            faces={{ show: t("device:strip.add.show"), hide: t("device:strip.add.hide") }}
          />
        </RowButton>
      }
    >
      <Reveal open={open}>
        <ul id={listId} className={styles.portList}>
          {ports.map((port) => (
            <li key={port.portName}>
              {port.product ?? shortPortName(port.portName)}
              {port.product ? <span className={styles.detail}> · {shortPortName(port.portName)}</span> : null}
            </li>
          ))}
        </ul>
      </Reveal>
    </SettingRow>
  );
}
