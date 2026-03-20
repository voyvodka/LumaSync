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

  const normalizedMarkerIndex = ((markerIndex % sequence.length) + sequence.length) % sequence.length;
  return sequence[normalizedMarkerIndex] ?? null;
}

const SEGMENT_ORDER: LedSegmentKey[] = ["top", "right", "bottomRight", "bottomLeft", "left"];

const SEGMENT_ANCHOR_TO_KEY: Record<LedStartAnchor, { segment: LedSegmentKey; localIndex: "start" | "end" }> = {
  "top-start": { segment: "top", localIndex: "start" },
  "top-end": { segment: "top", localIndex: "end" },
  "left-start": { segment: "left", localIndex: "start" },
  "left-end": { segment: "left", localIndex: "end" },
  "right-start": { segment: "right", localIndex: "start" },
  "right-end": { segment: "right", localIndex: "end" },
  "bottom-left-start": { segment: "bottomLeft", localIndex: "start" },
  "bottom-left-end": { segment: "bottomLeft", localIndex: "end" },
  "bottom-right-start": { segment: "bottomRight", localIndex: "start" },
  "bottom-right-end": { segment: "bottomRight", localIndex: "end" },
};

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

function resolveAnchorIndex(sequence: LedSequenceItem[], startAnchor: LedStartAnchor): number {
  const anchor = SEGMENT_ANCHOR_TO_KEY[startAnchor];
  const anchorCandidate =
    anchor.localIndex === "start"
      ? sequence.find((item) => item.segment === anchor.segment && item.localIndex === 0)
      : [...sequence].reverse().find((item) => item.segment === anchor.segment);

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
  const anchorIndex = resolveAnchorIndex(canonical, config.startAnchor);
  const rotated = rotateSequence(canonical, anchorIndex);

  if (config.direction === "cw") {
    return rotated;
  }

  if (rotated.length <= 1) {
    return rotated;
  }

  return [rotated[0], ...rotated.slice(1).reverse()];
}
