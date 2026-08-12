/**
 * EdgeSignalGrid — live per-edge gradient preview on the Lights page. It owns
 * the ~10 Hz `edge-signal` subscription ON PURPOSE: held in `LightsSection`,
 * every frame re-rendered the whole section to repaint four gradients.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  EDGE_SIGNAL_EVENT,
  type EdgeSignalPayload,
} from "@/features/mode/model/contracts";
import type { LedSegmentCounts } from "@/shared/contracts/calibration";

function rgbTripletToCss(triplet: [number, number, number]): string {
  return `rgb(${triplet[0]},${triplet[1]},${triplet[2]})`;
}

function buildLinearGradient(
  direction: "to right" | "to bottom",
  samples: Array<[number, number, number]>,
): string | undefined {
  if (samples.length === 0) return undefined;
  if (samples.length === 1) return rgbTripletToCss(samples[0]);
  return `linear-gradient(${direction},${samples.map(rgbTripletToCss).join(",")})`;
}

/** Props for {@link EdgeSignalGrid}. */
export interface EdgeSignalGridProps {
  /** Subscribe only while Ambilight is active — no IPC traffic otherwise. */
  isAmbilight: boolean;
  counts?: LedSegmentCounts;
  displayIndex: number;
  resolutionLabel: string | null;
}

/** Renders live per-edge capture-color gradients plus the display center tile. */
export function EdgeSignalGrid({
  isAmbilight,
  counts,
  displayIndex,
  resolutionLabel,
}: EdgeSignalGridProps) {
  const { t } = useTranslation();
  const [edgeSignal, setEdgeSignal] = useState<EdgeSignalPayload | null>(null);

  useEffect(() => {
    if (!isAmbilight) {
      setEdgeSignal(null);
      return;
    }
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen<EdgeSignalPayload>(EDGE_SIGNAL_EVENT, (event) => {
      if (!cancelled) setEdgeSignal(event.payload);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((error) => {
        console.error("[LumaSync] EdgeSignalGrid listen failed:", error);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isAmbilight]);

  const edgeGradients = useMemo(() => ({
    top: edgeSignal ? buildLinearGradient("to right", edgeSignal.top) : undefined,
    bottom: edgeSignal ? buildLinearGradient("to right", edgeSignal.bottom) : undefined,
    left: edgeSignal ? buildLinearGradient("to bottom", edgeSignal.left) : undefined,
    right: edgeSignal ? buildLinearGradient("to bottom", edgeSignal.right) : undefined,
  }), [edgeSignal]);

  return (
    <div className="lm-edges" aria-label={t("lights:signal.edgesAria")}>
      <div
        className="lm-edge lm-edge-top"
        style={edgeGradients.top ? { background: edgeGradients.top } : undefined}
      >
        <span className="label">
          {t("lights:signal.edges.top", { count: counts?.top ?? 0 })}
        </span>
      </div>
      <div
        className="lm-edge lm-edge-l"
        style={edgeGradients.left ? { background: edgeGradients.left } : undefined}
      >
        <span className="label">
          {t("lights:signal.edges.left", { count: counts?.left ?? 0 })}
        </span>
      </div>
      <div className="lm-edge lm-edge-c">
        <div className="scene">
          <b>{t("lights:signal.display.label", { index: displayIndex })}</b>
          {resolutionLabel ?? t("lights:signal.display.sub")}
        </div>
      </div>
      <div
        className="lm-edge lm-edge-r"
        style={edgeGradients.right ? { background: edgeGradients.right } : undefined}
      >
        <span className="label">
          {t("lights:signal.edges.right", { count: counts?.right ?? 0 })}
        </span>
      </div>
      <div
        className="lm-edge lm-edge-bot"
        style={edgeGradients.bottom ? { background: edgeGradients.bottom } : undefined}
      >
        <span className="label">
          {t("lights:signal.edges.bot", { count: counts?.bottom ?? 0 })}
        </span>
      </div>
    </div>
  );
}
