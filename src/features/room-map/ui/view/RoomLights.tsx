import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { QuickLights } from "@/features/lights/ui/QuickLights";
import { MODE_KIND_ORDER, modeKind } from "@/features/mode/model/modeKinds";
import { useRunningLightingMode } from "@/features/mode/state/lightingControl";
import { LIGHTING_MODE_KIND } from "@/shared/contracts/mode";
import { Popover } from "@/shared/ui/Popover/Popover";

import styles from "./RoomLights.module.css";

/** No per-light colour here: the running mode drives every output, and the modes have no override. */
export function RoomLights({ buttonClassName }: { buttonClassName?: string }) {
  const { t } = useTranslation();
  const running = useRunningLightingMode();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  // The popover renders into the body, so Tab from the button would reach it last.
  useEffect(() => {
    if (!open) return;
    const root = document.getElementById(id);
    const mode = root?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"][data-testid^="mode-button-"]');
    (mode ?? root?.querySelector<HTMLElement>("[data-power]"))?.focus({ preventScroll: true });
  }, [open, id]);
  if (!running) return null;
  const kind = modeKind(running.kind);
  const lit = running.kind !== LIGHTING_MODE_KIND.OFF;
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={buttonClassName}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={t("roomMap:view.lightsControl", { mode: t(kind.labelKey) })}
        onClick={() => setOpen((was) => !was)}
        data-testid="room-lights"
      >
        <span className={styles.dot} data-lit={lit || undefined} aria-hidden="true" />
        {/* Every label in one cell, the running one shown, so the button keeps its width as the mode changes. */}
        <span className={styles.labels}>
          {MODE_KIND_ORDER.map((each) => {
            const desc = modeKind(each);
            return (
              <span key={each} lang={desc.labelLang} aria-hidden={each !== running.kind || undefined} data-shown={each === running.kind || undefined}>
                {t(desc.labelKey)}
              </span>
            );
          })}
        </span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} side="below" width={320} id={id} label={t("roomMap:view.allLights")} role="dialog">
        <div className={styles.panel}>
          <QuickLights scenes={false} />
        </div>
      </Popover>
    </>
  );
}
