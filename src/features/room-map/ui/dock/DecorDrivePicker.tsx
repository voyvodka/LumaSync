import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { HueChannelPlacement } from "@/shared/contracts/roomMap";
import { PickerList } from "@/shared/ui/PickerList/PickerList";

import { hueChannelDotText, hueChannelName } from "../../model/hueChannelLabel";
import { Disc, Meta, RowLink } from "./InspectorParts";
import styles from "./DockPicker.module.css";

/** An action, not a value: it lists the Hue lights that can take a house light's place. */
export function DecorDrivePicker({ channels, onDrive }: { channels: readonly HueChannelPlacement[]; onDrive: (channelIndex: number) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  const free = channels.filter((ch) => !ch.locked);
  if (free.length === 0) return <Meta>{t("roomMap:inspector.decorDriveNone")}</Meta>;
  return (
    <>
      <RowLink ref={anchorRef} menu={{ open, id: listId }} onClick={() => setOpen((was) => !was)}>
        {t("roomMap:inspector.decorDriveAction")}
      </RowLink>
      <PickerList
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        side="above"
        id={listId}
        label={t("roomMap:inspector.decorDriveLabel")}
        width="fit"
        items={free}
        itemKey={(ch) => String(ch.channelIndex)}
        selectedIndex={-1}
        renderItem={(ch) => (
          <>
            <span className={styles.mark}>
              <Disc fill="rgb(255 255 255 / 80%)">{hueChannelDotText(ch.channelId)}</Disc>
            </span>
            <span>{hueChannelName(ch, t)}</span>
          </>
        )}
        onPick={(index) => {
          const picked = free[index];
          setOpen(false);
          if (picked) onDrive(picked.channelIndex);
        }}
      />
    </>
  );
}
