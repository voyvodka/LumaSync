import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import type { HueZone } from "@/shared/contracts/roomMap";
import { getZoneColor } from "../model/zoneColor";

/**
 * Inline "Move to → <zone>" popover anchored to a channel row's move
 * button. Renders fixed-positioned next to the trigger so it can never
 * be clipped by the dock's vertical scroll. Closes on outside click,
 * Escape, or zone pick — keeps focus management trap-free.
 */
export function MovePopover({
  zones,
  currentZoneId,
  onPick,
  onClose,
  triggerRect,
}: {
  zones: HueZone[];
  currentZoneId: string | null;
  onPick: (zoneId: string | null) => void;
  onClose: () => void;
  triggerRect: DOMRect | null;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-move-popover]")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!triggerRect) return null;
  const top = Math.max(8, triggerRect.bottom + 4);
  const left = Math.max(8, triggerRect.right - 200);

  return (
    <div
      data-move-popover
      role="menu"
      aria-label={t("roomMap:hueZones.movePopoverLabel")}
      className="lm-room-dock-move-popover"
      style={{ position: "fixed", top, left }}
    >
      <button
        type="button"
        role="menuitem"
        className={`lm-room-dock-move-item ${currentZoneId === null ? "is-on" : ""}`}
        onClick={() => {
          onPick(null);
          onClose();
        }}
      >
        <span
          className="lm-room-dock-move-item-dot"
          style={{ background: "var(--lm-ink-faint)" }}
          aria-hidden
        />
        <span>{t("roomMap:hueZones.unassignedTitle")}</span>
      </button>
      {zones.map((z, zi) => (
        <button
          key={z.id}
          type="button"
          role="menuitem"
          className={`lm-room-dock-move-item ${currentZoneId === z.id ? "is-on" : ""}`}
          onClick={() => {
            onPick(z.id);
            onClose();
          }}
        >
          <span
            className="lm-room-dock-move-item-dot"
            style={{ background: getZoneColor(z, zi) }}
            aria-hidden
          />
          <span>{z.name}</span>
        </button>
      ))}
    </div>
  );
}
