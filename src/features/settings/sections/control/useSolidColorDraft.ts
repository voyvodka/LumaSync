import { useEffect, useState } from "react";

import { useThrottledCommit } from "@/shared/lib/useThrottledCommit";

interface SolidDraft {
  r: number;
  g: number;
  b: number;
  brightness: number;
}

const SOLID_COMMIT_MIN_INTERVAL_MS = 50;

function isSameSolidDraft(left: SolidDraft, right: SolidDraft): boolean {
  return (
    left.r === right.r &&
    left.g === right.g &&
    left.b === right.b &&
    Math.abs(left.brightness - right.brightness) < 0.001
  );
}

export interface UseSolidColorDraftOptions {
  incoming: { r: number; g: number; b: number; brightness: number };
  onCommit: (draft: { r: number; g: number; b: number; brightness: number }) => void;
}

export function useSolidColorDraft({ incoming, onCommit }: UseSolidColorDraftOptions) {
  const [draft, setDraft] = useState<SolidDraft>(incoming);
  const throttle = useThrottledCommit(onCommit, SOLID_COMMIT_MIN_INTERVAL_MS);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the fields, not the object callers rebuild every render
  useEffect(() => {
    if (throttle.isPending()) return;
    setDraft((prev) => (isSameSolidDraft(prev, incoming) ? prev : incoming));
  }, [incoming.brightness, incoming.b, incoming.g, incoming.r]);

  const setColor = (color: { r: number; g: number; b: number }) => {
    const next = { ...draft, ...color };
    setDraft(next);
    throttle.push(next);
  };

  const setBrightness = (brightness: number) => {
    const next = { ...draft, brightness: Number.isFinite(brightness) ? brightness : draft.brightness };
    setDraft(next);
    throttle.push(next);
  };

  return { draft, setColor, setBrightness };
}
