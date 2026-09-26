import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LedDirection } from "../../model/contracts";
import { same, stops, type StartPoint, type StripShape } from "../../model/startPoint";
import { usePlaceLabel } from "../placeLabel";
import { IconRefresh } from "@/shared/ui/icons";
import { PageSwap, type PageWay } from "@/shared/ui/PageSwap/PageSwap";
import { SpinSwap } from "@/shared/ui/SpinSwap/SpinSwap";
import { PickerList } from "./PickerList";
import { PlaceGlyph } from "./PlaceGlyph";
import styles from "./StartControl.module.css";

interface StartControlProps {
  shape: StripShape;
  start: StartPoint;
  onSetStart: (start: StartPoint) => void;
  onNudge: (step: 1 | -1) => void;
  onDirection: (direction: LedDirection) => void;
}

/** Where the strip starts: ‹ and › step the named places, the name opens their list, ↻ turns the direction. */
export function StartControl({ shape, start, onSetStart, onNudge, onDirection }: StartControlProps) {
  const { t } = useTranslation();
  const placeLabel = usePlaceLabel();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  const list = useMemo(() => stops(shape, start.direction), [shape, start.direction]);
  const current = list.findIndex((st) => same(st.led, start.led));
  // How the next change of the name arrives: ‹ › page it sideways, a pick from the list (which
  // opens above) drops it in, anything else fades. Set by the press, cleared after each commit.
  const wayRef = useRef<PageWay>("fade");
  useEffect(() => {
    wayRef.current = "fade";
  });
  const nudge = (step: 1 | -1) => {
    wayRef.current = step > 0 ? "next" : "prev";
    onNudge(step);
  };
  const name = placeLabel(shape, start.led);
  // The tooltip says which way it runs now, matching the icon; the name says what a press does.
  const wayNow = t(start.direction === "cw" ? "calibration:setup.cw" : "calibration:setup.ccw");
  const turnLabel = t(start.direction === "cw" ? "calibration:setup.toCcw" : "calibration:setup.toCw");

  return (
    <div className={styles.start}>
      <button type="button" onClick={() => nudge(-1)} aria-label={t("calibration:setup.prevStop")} className={styles.nudge}>
        ‹
      </button>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${t("calibration:setup.firstLed")}: ${name}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") nudge(-1);
          else if (e.key === "ArrowRight") nudge(1);
        }}
        className={styles.name}
      >
        {/* Keyed by the place's name, not the LED: flipping direction at a corner moves LED #1 to
            the other edge's LED at that corner, which is the same place and must not page. */}
        <PageSwap id={name} way={wayRef.current}>
          <PlaceGlyph shape={shape} led={start.led} />
          <span className={styles.text}>{name}</span>
        </PageSwap>
      </button>
      <button
        type="button"
        onClick={() => onDirection(start.direction === "cw" ? "ccw" : "cw")}
        aria-label={turnLabel}
        title={wayNow}
        className={styles.direction}
      >
        <SpinSwap
          value={start.direction}
          turn={(d) => d}
          render={(d) => (
            <span className={d === "ccw" ? styles.mirrored : undefined}>
              <IconRefresh />
            </span>
          )}
        />
      </button>
      <button type="button" onClick={() => nudge(1)} aria-label={t("calibration:setup.nextStop")} className={styles.nudge}>
        ›
      </button>
      <PickerList
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        id={listId}
        label={t("calibration:setup.firstLed")}
        items={list}
        itemKey={(st) => `${st.led.edge}${st.led.k}`}
        selectedIndex={current}
        renderItem={(st, selected) => (
          <>
            <PlaceGlyph shape={shape} led={st.led} land={selected} />
            {placeLabel(shape, st.led)}
          </>
        )}
        onPick={(i) => {
          const st = list[i];
          if (!st) return;
          wayRef.current = i === current ? "fade" : "drop";
          onSetStart({ led: st.led, direction: st.direction });
          setOpen(false);
          anchorRef.current?.focus();
        }}
      />
    </div>
  );
}
