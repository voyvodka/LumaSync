import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface RoomAwareIndicatorProps {
  /** `popover` anchors the explanation under the chip (toolbar); `inline`
   * expands it in the flow below (the Lights dock). */
  variant: "popover" | "inline";
}

/**
 * A quiet "room-aware is on" chip. Room-aware turns on by itself when a TV
 * anchor exists — a template adds one — so without this a user cannot tell
 * why their Hue lights sample differently. The chip is a disclosure so the
 * explanation is reachable by keyboard, not only by a hover tooltip.
 */
export function RoomAwareIndicator({ variant }: RoomAwareIndicatorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || variant !== "popover") return;
    const handleClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, variant]);

  return (
    <div
      ref={rootRef}
      className={`lm-room-aware is-${variant}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="lm-room-aware-chip"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t("roomMap:roomAware.ariaLabel")}
        title={t("roomMap:roomAware.ariaLabel")}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="lm-room-aware-pill">
          <span className="lm-room-aware-dot" aria-hidden />
          <span>{t("roomMap:roomAware.label")}</span>
        </span>
      </button>
      <div id={panelId} className="lm-room-aware-panel" hidden={!open}>
        <p>{t("roomMap:roomAware.body")}</p>
        <p className="lm-room-aware-why">{t("roomMap:roomAware.why")}</p>
      </div>
    </div>
  );
}
