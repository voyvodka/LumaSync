import type { LedCalibrationConfig } from "./contracts";
import type { LedSegmentKey, LedStartAnchor } from "./contracts";

export interface LedSequenceItem {
  index: number;
  segment: LedSegmentKey;
  localIndex: number;
}

export function resolveLedSequenceItem(
  sequence: LedSequenceItem[],
  markerIndex: number,
): LedSequenceItem | null {
  if (sequence.length === 0) {
    return null;
  }

  if (!Number.isFinite(markerIndex)) {
    return sequence[0] ?? null;
  }

  const normalizedMarkerIndex = ((markerIndex % sequence.length) + sequence.length) % sequence.length;
  return sequence[normalizedMarkerIndex] ?? null;
}

const SEGMENT_ORDER: LedSegmentKey[] = ["top", "right", "bottom", "left"];

type AnchorLocalIndexMode = "start" | "end" | "gapRight" | "gapLeft";

const SEGMENT_ANCHOR_TO_KEY: Record<
  LedStartAnchor,
  { segment: LedSegmentKey; localIndex: AnchorLocalIndexMode }
> = {
  "top-start": { segment: "top", localIndex: "start" },
  "top-end": { segment: "top", localIndex: "end" },
  "right-start": { segment: "right", localIndex: "start" },
  "right-end": { segment: "right", localIndex: "end" },
  "bottom-start": { segment: "bottom", localIndex: "start" },
  "bottom-end": { segment: "bottom", localIndex: "end" },
  "bottom-gap-right": { segment: "bottom", localIndex: "gapRight" },
  "bottom-gap-left": { segment: "bottom", localIndex: "gapLeft" },
  "left-start": { segment: "left", localIndex: "start" },
  "left-end": { segment: "left", localIndex: "end" },
};

function resolveBottomGapAnchorLocalIndex(
  bottomCount: number,
  bottomMissing: number,
  side: "right" | "left",
): number {
  if (bottomCount <= 1) {
    return 0;
  }

  if (bottomMissing > 0) {
    const rightSideCount = Math.floor(bottomCount / 2);
    if (side === "right") {
      return Math.max(0, rightSideCount - 1);
    }

    return Math.min(bottomCount - 1, rightSideCount);
  }

  const centerRight = Math.max(0, Math.floor((bottomCount - 1) / 2));
  const centerLeft = Math.min(bottomCount - 1, Math.ceil((bottomCount - 1) / 2));
  return side === "right" ? centerRight : centerLeft;
}

function buildCanonicalSequence(config: LedCalibrationConfig): LedSequenceItem[] {
  const items: LedSequenceItem[] = [];
  for (const segment of SEGMENT_ORDER) {
    const count = config.counts[segment];
    for (let localIndex = 0; localIndex < count; localIndex += 1) {
      items.push({
        index: items.length,
        segment,
        localIndex,
      });
    }
  }
  return items;
}

function resolveAnchorIndex(sequence: LedSequenceItem[], config: LedCalibrationConfig): number {
  const { startAnchor } = config;
  const anchor = SEGMENT_ANCHOR_TO_KEY[startAnchor];
  const anchorCandidate = (() => {
    if (anchor.localIndex === "start") {
      return sequence.find((item) => item.segment === anchor.segment && item.localIndex === 0);
    }

    if (anchor.localIndex === "end") {
      return [...sequence].reverse().find((item) => item.segment === anchor.segment);
    }

    const targetLocalIndex = resolveBottomGapAnchorLocalIndex(
      config.counts.bottom,
      config.bottomMissing,
      anchor.localIndex === "gapRight" ? "right" : "left",
    );

    return sequence.find((item) => item.segment === "bottom" && item.localIndex === targetLocalIndex);
  })();

  return anchorCandidate ? sequence.indexOf(anchorCandidate) : 0;
}

function rotateSequence(sequence: LedSequenceItem[], startIndex: number): LedSequenceItem[] {
  if (sequence.length === 0) {
    return sequence;
  }

  return [...sequence.slice(startIndex), ...sequence.slice(0, startIndex)];
}

export function buildLedSequence(config: LedCalibrationConfig): LedSequenceItem[] {
  const canonical = buildCanonicalSequence(config);
  const anchorIndex = resolveAnchorIndex(canonical, config);
  const rotated = rotateSequence(canonical, anchorIndex);

  if (config.direction === "cw") {
    return rotated;
  }

  if (rotated.length <= 1) {
    return rotated;
  }

  return [rotated[0], ...rotated.slice(1).reverse()];
}
