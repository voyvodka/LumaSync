import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { shellStore } from "@/features/persistence/shellStore";
import type { FirmwareProfile, LedChipType } from "@/shared/contracts/device";
import { FirmwareProfilePicker } from "../control/FirmwareProfilePicker";
import { LedChipTypePicker } from "../control/LedChipTypePicker";
import { LedColorOrderControl } from "../control/LedColorOrderControl";

interface StoredStripSettings {
  firmwareProfile?: FirmwareProfile;
  chipType?: LedChipType;
}

export interface UsbStripSettingsProps {
  localTransport: "serial" | "wled" | null;
}

/**
 * What the strip itself needs: the wire protocol its firmware speaks, the
 * chip it is built from, and the order that chip takes its colours in. One
 * group, because all three describe the same piece of hardware.
 */
export function UsbStripSettings({ localTransport }: UsbStripSettingsProps) {
  const { t } = useTranslation();
  const titleId = useId();
  // Read once before the pickers mount, so neither paints its default first.
  const [stored, setStored] = useState<StoredStripSettings | null>(null);
  const [firmwareProfile, setFirmwareProfile] = useState<FirmwareProfile | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        setFirmwareProfile(state.firmwareProfile);
        setStored({ firmwareProfile: state.firmwareProfile, chipType: state.selectedChipType });
      })
      .catch((error: unknown) => {
        console.error("[LumaSync] UsbStripSettings hydrate failed:", error);
        if (!cancelled) setStored({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="lm-settings-group" aria-labelledby={titleId} data-testid="usb-strip-settings">
      <div className="lm-settings-group-h">
        <h2 className="t" id={titleId}>{t("device:page.usb.settings.title")}</h2>
      </div>
      {stored ? (
        <>
          <FirmwareProfilePicker
            initialProfile={stored.firmwareProfile}
            onProfileChange={setFirmwareProfile}
          />
          <LedChipTypePicker initialChipType={stored.chipType} firmwareProfile={firmwareProfile} />
          <LedColorOrderControl localTransport={localTransport} />
        </>
      ) : null}
    </section>
  );
}
