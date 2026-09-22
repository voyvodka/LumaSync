import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { RoomAwareStatus } from "../model/roomAware";

const PAUSED_REASON_KEYS = {
  keyRejected: "roomMap:roomAware.paused.keyRejected",
  unreachable: "roomMap:roomAware.paused.unreachable",
  checking: "roomMap:roomAware.paused.checking",
} as const;

interface RoomAwareIndicatorProps {
  /** `popover` anchors the explanation under the chip (toolbar); `inline`
   * expands it in the flow below (the Lights dock). */
  variant: "popover" | "inline";
  status: RoomAwareStatus;
}

/**
 * A quiet "room-aware is on" chip. Room-aware turns on by itself when a TV
 * anchor exists — a template adds one — so without this a user cannot tell
 * why their Hue lights sample differently. The chip is a disclosure so the
 * explanation is reachable by keyboard, not only by a hover tooltip.
 *
 * While the paired bridge cannot stream it reads "paused" instead: claiming
 * "on" over a Hue row that says re-pair is required is a false status.
 */
export function RoomAwareIndicator({ variant, status }: RoomAwareIndicatorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const paused = status.state === "paused";

  useEffect(() => {
    if (!open || variant !== "popover") return;
    const handleClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, variant]);

  const ariaLabel = paused
    ? t("roomMap:roomAware.pausedAriaLabel")
    : t("roomMap:roomAware.ariaLabel");

  return (
    <div
      ref={rootRef}
      className={`lm-room-aware is-${variant}${paused ? " is-paused" : ""}`}
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
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="lm-room-aware-pill">
          <span className="lm-room-aware-dot" aria-hidden />
          <span>
            {paused ? t("roomMap:roomAware.pausedLabel") : t("roomMap:roomAware.label")}
          </span>
        </span>
      </button>
      <div id={panelId} className="lm-room-aware-panel" hidden={!open}>
        {status.state === "paused" && <p>{t(PAUSED_REASON_KEYS[status.reason])}</p>}
        <p className={paused ? "lm-room-aware-why" : undefined}>{t("roomMap:roomAware.body")}</p>
        <p className="lm-room-aware-why">
          {paused ? t("roomMap:roomAware.pausedWhy") : t("roomMap:roomAware.why")}
        </p>
      </div>
    </div>
  );
}
