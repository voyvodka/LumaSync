import { useEffect, useState } from "react";

import { kelvinToRgb } from "@/shared/lib/color";
import { useThrottledCommit } from "@/shared/lib/useThrottledCommit";

/** `kelvin` present: Solid's White tab, its colour that temperature's white. */
export interface SolidDraft {
  r: number;
  g: number;
  b: number;
  brightness: number;
  kelvin?: number | null;
}

const SOLID_COMMIT_MIN_INTERVAL_MS = 50;

function isSameSolidDraft(left: SolidDraft, right: SolidDraft): boolean {
  return (
    left.r === right.r &&
    left.g === right.g &&
    left.b === right.b &&
    (left.kelvin ?? null) === (right.kelvin ?? null) &&
    Math.abs(left.brightness - right.brightness) < 0.001
  );
}

export interface UseSolidColorDraftOptions {
  incoming: SolidDraft;
  onCommit: (draft: SolidDraft) => void;
}

export function useSolidColorDraft({ incoming, onCommit }: UseSolidColorDraftOptions) {
  const [draft, setDraft] = useState<SolidDraft>(incoming);
  const throttle = useThrottledCommit(onCommit, SOLID_COMMIT_MIN_INTERVAL_MS);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the fields, not the object callers rebuild every render
  useEffect(() => {
    if (throttle.isPending()) return;
    setDraft((prev) => (isSameSolidDraft(prev, incoming) ? prev : incoming));
  }, [incoming.brightness, incoming.b, incoming.g, incoming.r, incoming.kelvin]);

  /** A picked colour is Colour, not White: it drops the temperature. */
  const setColor = (color: { r: number; g: number; b: number }) => {
    const { kelvin: _white, ...rest } = draft;
    const next = { ...rest, ...color };
    setDraft(next);
    throttle.push(next);
  };

  const setKelvin = (kelvin: number) => {
    const next = { ...draft, ...kelvinToRgb(kelvin), kelvin };
    setDraft(next);
    throttle.push(next);
  };

  const setBrightness = (brightness: number) => {
    const next = { ...draft, brightness: Number.isFinite(brightness) ? brightness : draft.brightness };
    setDraft(next);
    throttle.push(next);
  };

  return { draft, setColor, setKelvin, setBrightness };
}
