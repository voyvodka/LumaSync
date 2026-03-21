export type LedDirection = "cw" | "ccw";

export type CornerOwnership = "horizontal" | "vertical";

export type LedVisualPreset = "subtle" | "vivid";

export type LedSegmentKey = "top" | "right" | "bottom" | "left";

export type LedStartAnchor =
  | "top-start"
  | "top-end"
  | "right-start"
  | "right-end"
  | "bottom-start"
  | "bottom-end"
  | "bottom-gap-right"
  | "bottom-gap-left"
  | "left-start"
  | "left-end";

type LegacyLedStartAnchor =
  | "bottom-left-start"
  | "bottom-left-end"
  | "bottom-right-start"
  | "bottom-right-end";

interface LegacyLedSegmentCounts {
  top: number;
  left: number;
  right: number;
  bottomLeft: number;
  bottomRight: number;
}

export interface LedSegmentCounts {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface LedCalibrationConfig {
  templateId?: string;
  counts: LedSegmentCounts;
  bottomMissing: number;
  cornerOwnership: CornerOwnership;
  visualPreset: LedVisualPreset;
  startAnchor: LedStartAnchor;
  direction: LedDirection;
  totalLeds: number;
}

export interface CalibrationTemplate {
  id: string;
  label: string;
  counts: LedSegmentCounts;
  bottomMissing: number;
  cornerOwnership: CornerOwnership;
  visualPreset: LedVisualPreset;
  startAnchor: LedStartAnchor;
  direction: LedDirection;
}

export function sumSegmentCounts(counts: LedSegmentCounts): number {
  return counts.top + counts.right + counts.bottom + counts.left;
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function toDirection(value: unknown): LedDirection {
  return value === "ccw" ? "ccw" : "cw";
}

function toCornerOwnership(value: unknown): CornerOwnership {
  return value === "vertical" ? "vertical" : "horizontal";
}

function toVisualPreset(value: unknown): LedVisualPreset {
  return value === "subtle" ? "subtle" : "vivid";
}

function normalizeCounts(value: unknown): LedSegmentCounts {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};

  const top = toNonNegativeInt(source.top);
  const right = toNonNegativeInt(source.right);
  const left = toNonNegativeInt(source.left);
  const hasBottom = Object.prototype.hasOwnProperty.call(source, "bottom");

  if (hasBottom) {
    return {
      top,
      right,
      bottom: toNonNegativeInt(source.bottom),
      left,
    };
  }

  const legacy = source as Partial<LegacyLedSegmentCounts>;
  return {
    top,
    right,
    bottom: toNonNegativeInt(legacy.bottomLeft) + toNonNegativeInt(legacy.bottomRight),
    left,
  };
}

export function normalizeStartAnchor(value: unknown): LedStartAnchor {
  if (typeof value !== "string") {
    return "top-start";
  }

  const legacyMap: Record<LegacyLedStartAnchor, LedStartAnchor> = {
    "bottom-left-start": "bottom-end",
    "bottom-left-end": "bottom-end",
    "bottom-right-start": "bottom-start",
    "bottom-right-end": "bottom-start",
  };

  if (value in legacyMap) {
    return legacyMap[value as LegacyLedStartAnchor];
  }

  const valid: LedStartAnchor[] = [
    "top-start",
    "top-end",
    "right-start",
    "right-end",
    "bottom-start",
    "bottom-end",
    "bottom-gap-right",
    "bottom-gap-left",
    "left-start",
    "left-end",
  ];

  return valid.includes(value as LedStartAnchor) ? (value as LedStartAnchor) : "top-start";
}

export function normalizeLedCalibrationConfig(input?: unknown): LedCalibrationConfig | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const source = input as Record<string, unknown>;
  const counts = normalizeCounts(source.counts);
  const bottomMissing = toNonNegativeInt(source.bottomMissing);
  const normalizedStartAnchor = normalizeStartAnchor(source.startAnchor);
  const startAnchor =
    bottomMissing === 0
      ? normalizedStartAnchor === "bottom-gap-right"
        ? "bottom-start"
        : normalizedStartAnchor === "bottom-gap-left"
          ? "bottom-end"
          : normalizedStartAnchor
      : normalizedStartAnchor;

  return {
    templateId: typeof source.templateId === "string" ? source.templateId : undefined,
    counts,
    bottomMissing,
    cornerOwnership: toCornerOwnership(source.cornerOwnership),
    visualPreset: toVisualPreset(source.visualPreset),
    startAnchor,
    direction: toDirection(source.direction),
    totalLeds: sumSegmentCounts(counts),
  };
}
