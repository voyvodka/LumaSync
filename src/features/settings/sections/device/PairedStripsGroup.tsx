import { useCallback, useId, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";

import type { DevicePort } from "@/features/device/types";
import { shellStore } from "@/features/persistence/shellStore";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import type { UsbStripPlacement } from "@/shared/contracts/roomMap";
import { Button } from "@/shared/ui/Button";
import { Callout } from "@/shared/ui/Callout";
import { IconUsb } from "@/shared/ui/icons";
import { StatusPill } from "@/shared/ui/StatusPill";

import { portDisplayName } from "./UsbPortCards";

export interface PairedStripsGroupProps {
  pairedStrips: UsbStripPlacement[];
  setPairedStrips: Dispatch<SetStateAction<UsbStripPlacement[]>>;
  /** Ports a strip may be moved to: supported ones only. */
  supportedPorts: DevicePort[];
  connectedPort: string | null;
  persistError: boolean;
  flagPersistError: () => void;
  clearPersistError: () => void;
  onRescan: () => void;
  onNavigateToRoomMap?: () => void;
}

/** Every strip the app knows about, with the port that drives it. */
export function PairedStripsGroup({
  pairedStrips,
  setPairedStrips,
  supportedPorts,
  connectedPort,
  persistError,
  flagPersistError,
  clearPersistError,
  onRescan,
  onNavigateToRoomMap,
}: PairedStripsGroupProps) {
  const { t } = useTranslation();
  const titleId = useId();
  // One row in edit mode at a time. The dropdown includes the strip's own
  // current port, or cancelling would leave the slot pointing at nothing.
  const [editStripId, setEditStripId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<string | null>(null);

  // One strip per controller: a port already on a strip is not offered again.
  const pairedPortNames = new Set(
    pairedStrips.map((s) => s.portName).filter((name): name is string => !!name),
  );
  const unpairedPortNames = supportedPorts
    .map((p) => p.portName)
    .filter((name) => !pairedPortNames.has(name));

  // Rescans so a controller plugged in since the last scan is selectable.
  const openEditor = useCallback(
    (stripId: string, currentPort: string | null) => {
      setEditStripId(stripId);
      setEditDraft(currentPort);
      onRescan();
    },
    [onRescan],
  );

  const closeEditor = useCallback(() => {
    setEditStripId(null);
    setEditDraft(null);
  }, []);

  // The duplicate-port guard is mandatory even though the dropdown filters
  // paired ports out: a stale selection from a concurrent edit still lands here.
  const savePort = useCallback(async () => {
    const targetId = editStripId;
    const nextPort = editDraft;
    if (!targetId || !nextPort) return;
    const target = pairedStrips.find((s) => s.stripId === targetId);
    if (!target || target.portName === nextPort) {
      closeEditor();
      return;
    }
    if (pairedPortNames.has(nextPort)) {
      console.error("[LumaSync] PairedStripsGroup: port already paired", nextPort);
      flagPersistError();
      return;
    }
    try {
      const current = await shellStore.load();
      const roomMap = current.roomMap ?? DEFAULT_ROOM_MAP;
      const usbStrips = roomMap.usbStrips.map((s) =>
        s.stripId === targetId ? { ...s, portName: nextPort } : s,
      );
      await shellStore.save({
        roomMap: { ...roomMap, usbStrips },
        roomMapVersion: (current.roomMapVersion ?? 0) + 1,
      });
      setPairedStrips(usbStrips);
      closeEditor();
      clearPersistError();
    } catch (e) {
      console.error("[LumaSync] PairedStripsGroup: saving the strip port failed", e);
      flagPersistError();
    }
  }, [
    editStripId,
    editDraft,
    pairedStrips,
    pairedPortNames,
    closeEditor,
    setPairedStrips,
    flagPersistError,
    clearPersistError,
  ]);

  return (
    <section className="lm-settings-group" aria-labelledby={titleId} data-testid="usb-paired-strips">
      <div className="lm-settings-group-h">
        <h2 className="t" id={titleId}>{t("device:page.usb.paired.title")}</h2>
        <span className="sub">{t("device:page.usb.paired.count", { count: pairedStrips.length })}</span>
      </div>
      <div className="lm-usb-group-body">
        {pairedStrips.length === 0 ? (
          <p className="lm-paired-strips-empty">{t("device:page.usb.paired.empty")}</p>
        ) : (
          pairedStrips.map((strip) => {
            // A strip authored before strips carried a port follows whichever
            // port is live, so an existing map keeps its badge until re-linked.
            const live = strip.portName ? strip.portName === connectedPort : connectedPort !== null;
            const portLabel = strip.portName ?? connectedPort ?? t("device:page.usb.paired.noPort");
            const editing = editStripId === strip.stripId;
            const options = editing
              ? Array.from(new Set([...(strip.portName ? [strip.portName] : []), ...unpairedPortNames]))
              : [];
            return (
              <div key={strip.stripId} className="lm-paired-strip" data-testid="usb-paired-strip">
                <div className="lm-paired-strip-ic"><IconUsb /></div>
                <div className="lm-paired-strip-tx">
                  <div className="lm-paired-strip-name">
                    {t("device:page.usb.paired.stripName", { count: strip.ledCount })}
                  </div>
                  {editing ? (
                    <select
                      className="lm-paired-strip-select"
                      value={editDraft ?? ""}
                      onChange={(e) => setEditDraft(e.target.value || null)}
                      aria-label={t("device:page.usb.paired.portLabel")}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void savePort();
                        } else if (e.key === "Escape") {
                          closeEditor();
                        }
                      }}
                    >
                      {options.length === 0 ? (
                        <option value="" disabled>
                          {t("device:page.usb.paired.noOtherPort")}
                        </option>
                      ) : (
                        options.map((portName) => {
                          const port = supportedPorts.find((p) => p.portName === portName);
                          const display = port ? portDisplayName(port) : portName;
                          return (
                            <option key={portName} value={portName}>
                              {display === portName ? portName : `${display} (${portName})`}
                            </option>
                          );
                        })
                      )}
                    </select>
                  ) : (
                    <div className="lm-paired-strip-sub">{portLabel}</div>
                  )}
                </div>
                <div className="lm-paired-strip-actions">
                  {editing ? (
                    <>
                      <Button size="md" onClick={closeEditor}>
                        {t("device:page.usb.paired.changePortCancel")}
                      </Button>
                      <Button size="md" variant="primary" onClick={() => { void savePort(); }} disabled={!editDraft}>
                        {t("device:page.usb.paired.changePortConfirm")}
                      </Button>
                    </>
                  ) : (
                    <>
                      <StatusPill tone={live ? "ok" : "idle"}>
                        {live ? t("device:page.usb.pill.online") : t("device:page.usb.paired.offline")}
                      </StatusPill>
                      <Button size="md" onClick={() => openEditor(strip.stripId, strip.portName ?? null)}>
                        {t("device:page.usb.paired.changePort")}
                      </Button>
                      {onNavigateToRoomMap ? (
                        <Button size="md" onClick={onNavigateToRoomMap}>
                          {t("device:page.usb.paired.openInMap")}
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
        {persistError ? (
          <Callout tone="error">{t("device:page.usb.paired.persistError")}</Callout>
        ) : null}
      </div>
    </section>
  );
}
