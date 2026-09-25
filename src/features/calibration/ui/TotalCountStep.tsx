import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LedChipType } from "@/shared/contracts/device";
import type { LedSegmentKey } from "../model/contracts";
import { estimateStripPower } from "../model/powerEstimate";
import { ALL_EDGES, MAX_STRIP_LEDS } from "../model/splitTotal";
import { dockChoiceClass, FOCUS_RING } from "./dockStyles";

interface TotalCountStepProps {
  /** Pre-filled total: what a WLED panel reported, else the layout's own. */
  initialTotal: number | null;
  initialEdges: readonly LedSegmentKey[];
  /** What a bound WLED panel reports, said out loud when it is the pre-fill. */
  knownTotal: number | null;
  chipType: LedChipType;
  /** Only when the user asked for the step; a first visit keeps focus where it was. */
  autoFocus: boolean;
  onApply: (total: number, edges: LedSegmentKey[]) => void;
  onSkip: () => void;
}

const EDGE_LABEL_KEYS = {
  top: "calibration:page.edgeTop",
  right: "calibration:page.edgeRight",
  bottom: "calibration:page.edgeBottom",
  left: "calibration:page.edgeLeft",
} as const satisfies Record<LedSegmentKey, string>;

/** LED Setup's first question: the strip's total, split over the edges it runs along. */
export function TotalCountStep({
  initialTotal,
  initialEdges,
  knownTotal,
  chipType,
  autoFocus,
  onApply,
  onSkip,
}: TotalCountStepProps) {
  const { t } = useTranslation();
  const inputId = useId();
  const noteId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(initialTotal ? String(initialTotal) : "");
  const [edges, setEdges] = useState<LedSegmentKey[]>(() => ALL_EDGES.filter((edge) => initialEdges.includes(edge)));

  // A WLED count read after the step mounted still pre-fills it, unless the
  // user has already typed.
  const typedRef = useRef(false);
  useEffect(() => {
    if (!typedRef.current && initialTotal) setDraft(String(initialTotal));
  }, [initialTotal]);

  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [autoFocus]);

  const total = Number.parseInt(draft, 10);
  const totalValid = Number.isInteger(total) && total >= 1 && total <= MAX_STRIP_LEDS;
  const canApply = totalValid && edges.length > 0;
  const power = estimateStripPower(totalValid ? total : 0, chipType);

  const apply = () => {
    if (canApply) onApply(total, edges);
  };

  const toggleEdge = (edge: LedSegmentKey) =>
    setEdges((current) =>
      current.includes(edge)
        ? current.filter((candidate) => candidate !== edge)
        : ALL_EDGES.filter((candidate) => candidate === edge || current.includes(candidate)),
    );

  return (
    <div className="flex flex-col gap-2" data-testid="calibration-total-step">
      <label htmlFor={inputId} className="text-xs font-medium leading-snug text-ink">
        {t("calibration:page.totalStep.question")}
      </label>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={4}
          autoComplete="off"
          value={draft}
          aria-describedby={noteId}
          aria-invalid={draft !== "" && !totalValid ? true : undefined}
          onChange={(event) => {
            typedRef.current = true;
            setDraft(event.target.value.replace(/[^0-9]/g, ""));
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // Focus moves to "Change total" as the step closes; an Enter left
            // uncancelled would go on to press it and reopen the step.
            event.preventDefault();
            apply();
          }}
          className={`h-8 w-24 min-w-0 rounded-md border border-line-2 bg-bg/40 px-2 font-mono text-sm font-medium text-ink outline-none placeholder:text-ink-faint aria-invalid:border-red/60 ${FOCUS_RING}`}
        />
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-dim">
          {t("calibration:page.ledsUnit")}
        </span>
      </div>
      <div id={noteId} className="flex flex-col gap-1 text-[10.5px] leading-snug">
        {draft !== "" && !totalValid ? (
          <span className="text-red">{t("calibration:page.totalStep.outOfRange", { max: MAX_STRIP_LEDS })}</span>
        ) : totalValid ? (
          <span className="font-mono text-[10px] text-ink-dim" title={t("calibration:page.powerHint")}>
            {t("calibration:page.lengthAndPower", {
              meters: (total / 60).toFixed(1),
              watts: power.watts,
              amps: power.amps.toFixed(1),
            })}
          </span>
        ) : null}
        {knownTotal !== null ? (
          <span className="text-ink-dim">{t("calibration:page.totalStep.fromWled", { count: knownTotal })}</span>
        ) : (
          <span className="text-ink-faint">{t("calibration:page.totalStep.hint")}</span>
        )}
      </div>

      <div
        role="group"
        aria-label={t("calibration:page.totalStep.edgesLabel")}
        className="mt-1 flex flex-col gap-1"
      >
        <span aria-hidden className="text-[10.5px] leading-snug text-ink-faint">
          {t("calibration:page.totalStep.edgesLabel")}
        </span>
        <div className="grid grid-cols-4 gap-1">
          {ALL_EDGES.map((edge) => (
            <button
              key={edge}
              type="button"
              aria-pressed={edges.includes(edge)}
              onClick={() => toggleEdge(edge)}
              className={dockChoiceClass(edges.includes(edge), "px-1 font-mono text-[9px] uppercase")}
            >
              {t(EDGE_LABEL_KEYS[edge])}
            </button>
          ))}
        </div>
        {edges.length === 0 && (
          <span className="text-[10.5px] leading-snug text-red">{t("calibration:page.totalStep.noEdges")}</span>
        )}
      </div>

      <button
        type="button"
        disabled={!canApply}
        onClick={apply}
        className={`mt-1 min-h-8 rounded-md bg-amber px-3 py-1.5 text-xs font-semibold text-bg transition-colors hover:bg-amber disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING} focus-visible:ring-offset-2 focus-visible:ring-offset-bg`}
      >
        {t("calibration:page.totalStep.apply")}
      </button>
      <button
        type="button"
        onClick={onSkip}
        className={`min-h-8 rounded-md px-2 text-xs text-ink-dim underline-offset-2 transition-colors hover:text-ink hover:underline ${FOCUS_RING}`}
      >
        {t("calibration:page.totalStep.skip")}
      </button>
    </div>
  );
}
