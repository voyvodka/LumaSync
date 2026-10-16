import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { getPreference, previewPreference, setPreference, usePreference } from "@/features/persistence/preferences";
import { ROOM_AMBIENT_DEFAULT } from "@/shared/contracts/shell";
import { Popover } from "@/shared/ui/Popover/Popover";

import { DockSlider } from "./dock/DockSlider";
import styles from "./RoomDaylight.module.css";

const DAYLIGHT_BANDS = {
  night: "roomMap:settings.daylightBand.night",
  dusk: "roomMap:settings.daylightBand.dusk",
  day: "roomMap:settings.daylightBand.day",
} as const;

/** Where the slider reads as night, dusk and day: dusk around the default. */
function daylightBand(percent: number): keyof typeof DAYLIGHT_BANDS {
  if (percent < ROOM_AMBIENT_DEFAULT / 2) return "night";
  return percent < (ROOM_AMBIENT_DEFAULT + 100) / 2 ? "dusk" : "day";
}

/** How lit the 3D room is with no lamp on, as a value in the corner that opens its slider. */
export function RoomDaylight({ buttonClassName }: { buttonClassName?: string }) {
  const { t } = useTranslation();
  const ambient = usePreference("roomMapAmbient");
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const valueText = t("roomMap:settings.daylightValueText", { percent: ambient, band: t(DAYLIGHT_BANDS[daylightBand(ambient)]) });
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={buttonClassName}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={t("roomMap:view.daylightControl", { value: valueText })}
        onClick={() => setOpen((was) => !was)}
        data-testid="room-daylight"
      >
        <IconSun />
        <span className={styles.readout}>{ambient}%</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} side="below" width={260} id={id} label={t("roomMap:settings.daylight")} role="dialog">
        <DaylightSlider valueText={valueText} />
      </Popover>
    </>
  );
}

/** Follows the thumb and is saved where it is let go. */
function DaylightSlider({ valueText }: { valueText: string }) {
  const { t } = useTranslation();
  const ambient = usePreference("roomMapAmbient");
  // Whether it moved since the last save, not what was saved: another window's write changes the value.
  const moved = useRef(false);
  const commit = useRef((value: number) => {
    if (!moved.current) return;
    moved.current = false;
    void setPreference("roomMapAmbient", value);
  }).current;
  // Closed mid-drag (Esc), the shown value would otherwise never reach the disk.
  useEffect(() => () => commit(getPreference("roomMapAmbient")), [commit]);
  return (
    <div className={styles.row}>
      <span className={styles.label} aria-hidden="true">
        {t("roomMap:settings.daylight")}
      </span>
      <DockSlider
        className={styles.slider}
        label={t("roomMap:settings.daylightRange")}
        ariaValueText={valueText}
        min={0}
        max={100}
        step={1}
        value={ambient}
        onChange={(value) => {
          moved.current = true;
          previewPreference("roomMapAmbient", value);
        }}
        onCommit={commit}
        readout={`${ambient}%`}
        testId="room-ambient"
      />
    </div>
  );
}

function IconSun() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1" />
    </svg>
  );
}
