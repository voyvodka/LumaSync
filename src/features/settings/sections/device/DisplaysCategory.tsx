import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { shellStore } from "@/features/persistence/shellStore";
import type { DisplayInfo } from "@/shared/contracts/display";
import { IconDisplayGlyph } from "@/shared/ui/icons";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusPill } from "@/shared/ui/StatusPill";

export interface DisplaysCategoryProps {
  isActive: boolean;
  displays: DisplayInfo[];
  /** Ambilight runs, so the capture display is being captured right now. */
  capturing?: boolean;
  /** The display picker lives in LED Setup; this page only lists displays. */
  onOpenLedSetup?: () => void;
}

/**
 * The display the capture reads: the one LED Setup saved, or the primary when
 * none is saved or the saved one is gone — the same fallback Rust applies.
 */
export function captureDisplayId(displays: DisplayInfo[], selectedDisplayId: string | null): string | null {
  if (selectedDisplayId !== null && displays.some((display) => display.id === selectedDisplayId)) {
    return selectedDisplayId;
  }
  return displays.find((display) => display.isPrimary)?.id ?? displays[0]?.id ?? null;
}

export function DisplaysCategory({ isActive, displays, capturing = false, onOpenLedSetup }: DisplaysCategoryProps) {
  const { t } = useTranslation();
  const [selectedDisplayId, setSelectedDisplayId] = useState<string | null>(null);

  // Re-read on each visit: the choice is made in LED Setup, a different section.
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    shellStore
      .load()
      .then((state) => {
        if (!cancelled) setSelectedDisplayId(state.selectedDisplayId || null);
      })
      .catch((error: unknown) => {
        console.error("[LumaSync] DisplaysCategory: reading the capture display failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [isActive]);

  const sourceId = captureDisplayId(displays, selectedDisplayId);

  return (
    <div className="lm-device-cat-body" hidden={!isActive}>
      <div className="lm-device-head">
        <div>
          <h1>{t("device:page.header.displaysTitle")}</h1>
          <div className="lm-device-head-sub">{t("device:page.header.displaysSub")}</div>
        </div>
      </div>
      <div className="lm-device-grid">
        {displays.length === 0 ? (
          <EmptyState body={t("device:page.displays.empty")} />
        ) : (
          displays.map((display) => {
            const isSource = display.id === sourceId;
            return (
              <div
                key={display.id}
                className={isSource ? "lm-dcard is-on" : "lm-dcard"}
                data-testid={`display-card-${display.id}`}
              >
                <div className="lm-dcard-head">
                  <div className="lm-dcard-ic"><IconDisplayGlyph /></div>
                  <div className="lm-dcard-tx">
                    <div className="lm-dcard-name">
                      <span>{display.label}</span>
                      {display.isPrimary ? (
                        <StatusPill tone="idle">{t("device:page.displays.primary")}</StatusPill>
                      ) : null}
                      {isSource ? (
                        <StatusPill tone={capturing ? "ok" : "idle"}>
                          {capturing ? t("device:page.displays.capturing") : t("device:page.displays.captureSource")}
                        </StatusPill>
                      ) : null}
                    </div>
                    <div className="lm-dcard-sub">{`${display.width} × ${display.height}`}</div>
                  </div>
                </div>
                <div className="lm-dcard-body">
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("device:page.displays.cellId")}</div>
                    <div className="lm-dcard-cell-v">{display.id}</div>
                  </div>
                  <div className="lm-dcard-cell">
                    <div className="lm-dcard-cell-k">{t("device:page.displays.cellScale")}</div>
                    <div className="lm-dcard-cell-v">{display.scaleFactor.toFixed(1)}x</div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
      {displays.length > 0 && onOpenLedSetup ? (
        <div className="lm-dcard-actions">
          <button type="button" className="lm-dcard-act" onClick={onOpenLedSetup} data-testid="displays-open-led-setup">
            {t("device:page.displays.chooseInLedSetup")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
