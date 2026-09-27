import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { WLED_STATUS, type WledCommandStatus, type WledDeviceInfo } from "@/shared/contracts/device";
import { Reveal } from "@/shared/ui/Reveal/Reveal";
import { RowButton, RowNote, SettingRow } from "@/shared/ui/SettingRow/SettingRow";
import { StateSwap } from "@/shared/ui/StateSwap/StateSwap";

import { shortPortName } from "../model/deviceRail";
import { wledAddressError, wledStatusKey } from "../model/wledStatus";
import { connectAsUser } from "../state/connectAsUser";
import { useWledConnect, type WledConnectDeps } from "../state/useWledConnect";
import type { DevicePort } from "../types";
import type { UseDeviceConnectionResult } from "../useDeviceConnection";
import { ConnectErrorNote, connectFailedOn } from "./StripNotes";
import styles from "./StripPage.module.css";

/** What was just added, so the page it became can open and ask whether it lit. */
export type AddedOutput = { kind: "serial"; portName: string } | { kind: "wled"; ip: string };

/** The Add button: its busy label keeps the wider label's width, so nothing beside it moves. */
function AddButton({
  busy,
  primary,
  disabled,
  label,
  onClick,
  testId,
}: {
  busy: boolean;
  primary: boolean;
  disabled?: boolean;
  label?: string;
  onClick: () => void;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <RowButton
      primary={primary}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      aria-label={label}
      onClick={onClick}
      data-testid={testId}
    >
      <StateSwap
        fit
        state={busy ? "busy" : "idle"}
        faces={{ idle: t("device:strip.action.add"), busy: t("device:strip.action.adding") }}
      />
    </RowButton>
  );
}

interface FoundPortRowProps {
  port: DevicePort;
  device: UseDeviceConnectionResult;
  /** The row's name; the port's product when omitted. */
  label?: string;
  primary: boolean;
  /** Under the row, before any failure: what adding it changes. */
  note?: ReactNode;
  onAdded: (added: AddedOutput) => void;
}

/** A supported controller plugged in and not a strip yet: Add connects it. */
export function FoundPortRow({ port, device, label, primary, note, onAdded }: FoundPortRowProps) {
  const { t } = useTranslation();
  const name = port.product ?? shortPortName(port.portName);
  const adding = device.isConnecting && device.selectedPort === port.portName;
  const failed = connectFailedOn(device, port.portName);

  const add = async () => {
    if (await connectAsUser(device, port.portName)) onAdded({ kind: "serial", portName: port.portName });
  };

  return (
    <SettingRow
      label={label ?? name}
      value={label === undefined ? shortPortName(port.portName) : `${name} · ${shortPortName(port.portName)}`}
      testId="found-port"
      control={
        <AddButton
          busy={adding}
          primary={primary}
          disabled={device.isConnecting && !adding}
          label={t("device:strip.add.addNamed", { name })}
          onClick={() => void add()}
          testId="found-port-add"
        />
      }
    >
      <Reveal open={note !== undefined && note !== null}>{note}</Reveal>
      <Reveal open={failed}>{failed ? <ConnectErrorNote device={device} /> : null}</Reveal>
    </SettingRow>
  );
}

interface WledAddressRowProps {
  /** Records a bound device: the saved strip, and the switch away from the other outputs. */
  onBound: (device: WledDeviceInfo) => Promise<void>;
  onAdded: (added: AddedOutput) => void;
  primary: boolean;
  deps?: WledConnectDeps;
}

/** A WLED device by the address WLED shows: Add asks it what it is and binds it. */
export function WledAddressRow({ onBound, onAdded, primary, deps }: WledAddressRowProps) {
  const { t } = useTranslation();
  const errorId = useId();
  const [address, setAddress] = useState("");
  const [invalid, setInvalid] = useState<ReturnType<typeof wledAddressError>>(null);
  const [failure, setFailure] = useState<WledCommandStatus | null>(null);
  const wled = useWledConnect(deps);
  const adding = wled.connecting !== null;

  const add = async () => {
    const error = wledAddressError(address);
    setInvalid(error);
    setFailure(null);
    if (error) return;
    const ip = address.trim();
    const status = await wled.connect(ip, onBound);
    if (status.code === WLED_STATUS.CONNECT_OK) onAdded({ kind: "wled", ip });
    else setFailure(status);
  };

  const failureKey = failure ? wledStatusKey(failure.code) : null;
  return (
    <SettingRow
      label={t("device:strip.add.wled")}
      hint={t("device:strip.add.wledHint")}
      testId="wled-address"
      control={
        <>
          <input
            className={styles.input}
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setInvalid(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !adding) {
                event.preventDefault();
                void add();
              }
            }}
            placeholder={t("device:page.wled.manualIpPlaceholder")}
            aria-label={t("device:page.wled.manualIp")}
            aria-describedby={invalid ? errorId : undefined}
            aria-invalid={invalid ? true : undefined}
            spellCheck={false}
            autoComplete="off"
            inputMode="decimal"
            data-testid="wled-address-input"
          />
          <AddButton
            busy={adding}
            primary={primary && address.trim() !== ""}
            disabled={address.trim() === ""}
            onClick={() => void add()}
            testId="wled-address-add"
          />
        </>
      }
    >
      <Reveal open={invalid !== null}>
        {invalid ? (
          <RowNote tone="error">
            <span id={errorId}>{t(invalid)}</span>
          </RowNote>
        ) : null}
      </Reveal>
      <Reveal open={failure !== null}>
        {failure ? (
          <RowNote tone="error" testId="wled-address-failed">
            {failureKey ? t(failureKey) : failure.message}
          </RowNote>
        ) : null}
      </Reveal>
    </SettingRow>
  );
}
