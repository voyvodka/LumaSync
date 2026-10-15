import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Popover } from "@/shared/ui/Popover/Popover";
import { Reveal } from "@/shared/ui/Reveal/Reveal";

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
  const chipRef = useRef<HTMLButtonElement>(null);
  const paused = status.state === "paused";

  const ariaLabel = paused
    ? t("roomMap:roomAware.pausedAriaLabel")
    : t("roomMap:roomAware.ariaLabel");

  const panel = (
    <div id={variant === "inline" ? panelId : undefined} className="lm-room-aware-panel">
      {status.state === "paused" && <p>{t(PAUSED_REASON_KEYS[status.reason])}</p>}
      <p className={paused ? "lm-room-aware-why" : undefined}>{t("roomMap:roomAware.body")}</p>
      <p className="lm-room-aware-why">
        {paused ? t("roomMap:roomAware.pausedWhy") : t("roomMap:roomAware.why")}
      </p>
    </div>
  );

  return (
    <div
      className={`lm-room-aware is-${variant}${paused ? " is-paused" : ""}`}
      onKeyDown={(e) => {
        // Kept from the editor, whose Esc would clear the selection under the open panel.
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        ref={chipRef}
        type="button"
        className="lm-room-aware-chip"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
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
      {/* It opens as the app's other popovers and rows do, rising in and settling out. */}
      {variant === "popover" ? (
        <Popover open={open} onClose={() => setOpen(false)} anchorRef={chipRef} side="below" width={248} id={panelId} label={ariaLabel} role="dialog">
          {panel}
        </Popover>
      ) : (
        <Reveal open={open}>{panel}</Reveal>
      )}
    </div>
  );
}
