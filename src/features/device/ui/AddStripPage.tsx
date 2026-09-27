import { useId } from "react";
import { useTranslation } from "react-i18next";

import type { WledDeviceInfo } from "@/shared/contracts/device";
import { Reveal } from "@/shared/ui/Reveal/Reveal";
import { RowNote, SettingRow } from "@/shared/ui/SettingRow/SettingRow";

import type { DevicePort } from "../types";
import type { UseDeviceConnectionResult } from "../useDeviceConnection";
import { FoundPortRow, WledAddressRow, type AddedOutput } from "./AddStripRows";
import styles from "./StripPage.module.css";

interface AddStripPageProps {
  isActive: boolean;
  /** "Add a strip", or the name of a strip that has lost its controller. */
  title: string;
  /** Supported ports plugged in that no strip is on. */
  ports: readonly DevicePort[];
  device: UseDeviceConnectionResult;
  onWledBound: (device: WledDeviceInfo) => Promise<void>;
  /** The strip adding one moves: one strip is driven at a time for now. */
  replaces: string | null;
  onAdded: (added: AddedOutput) => void;
}

/** Adding a strip: a controller plugged in, listed as it appears, or a WLED device by address. */
export function AddStripPage({ isActive, title, ports, device, onWledBound, replaces, onAdded }: AddStripPageProps) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section className={styles.page} hidden={!isActive} aria-labelledby={headingId} data-testid="add-strip-page">
      <h1 id={headingId} className={styles.heading}>
        {title}
      </h1>
      {replaces !== null ? (
        <RowNote tone="status" testId="add-strip-replaces">{t("device:strip.add.replaces", { name: replaces })}</RowNote>
      ) : null}
      <div className={styles.rows}>
        <Reveal open={ports.length === 0}>
          <SettingRow label={t("device:strip.add.usb")} value={t("device:strip.add.usbNone")} testId="add-strip-usb" />
        </Reveal>
        {ports.map((port) => (
          <Reveal key={port.portName} open appear>
            <FoundPortRow port={port} device={device} primary={ports.length === 1} onAdded={onAdded} />
          </Reveal>
        ))}
        <Reveal open>
          <WledAddressRow onBound={onWledBound} onAdded={onAdded} primary={ports.length === 0} />
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
    <section className={styles.page} hidden={!isActive} aria-labelledby={headingId} data-testid="found-port-page">
      <h1 id={headingId} className={styles.heading}>
        {port.product ?? port.portName}
      </h1>
      <div className={styles.rows}>
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
