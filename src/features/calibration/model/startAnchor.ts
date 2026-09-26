import type { LedCalibrationConfig, LedStartAnchor } from "./contracts";
import { resolveBottomGapAnchorLocalIndex } from "./indexMapping";

export type AnchorEdge = "top" | "right" | "bottom" | "left";
export type AnchorEndpoint = "start" | "end" | "gap-right" | "gap-left";

export function edgeOfAnchor(anchor: LedStartAnchor): AnchorEdge {
  if (anchor.startsWith("top")) return "top";
  if (anchor.startsWith("right")) return "right";
  if (anchor.startsWith("bottom")) return "bottom";
  return "left";
}

function endpointOfAnchor(anchor: LedStartAnchor): AnchorEndpoint {
  if (anchor === "bottom-gap-right") return "gap-right";
  if (anchor === "bottom-gap-left") return "gap-left";
  return anchor.endsWith("-end") ? "end" : "start";
}

function anchorFromEdgeEndpoint(edge: AnchorEdge, endpoint: AnchorEndpoint): LedStartAnchor {
  if (endpoint === "gap-right") return "bottom-gap-right";
  if (endpoint === "gap-left") return "bottom-gap-left";
  return `${edge}-${endpoint}` as LedStartAnchor;
}

export interface LedOnEdge {
  edge: AnchorEdge;
  k: number;
}

type AnchorShape = Pick<LedCalibrationConfig, "counts" | "bottomMissing" | "startAnchor" | "startLocalIndex">;

/** The LED `startAnchor` (and `startLocalIndex`, when there is one) names, as its edge and local index. */
export function ledOfAnchor(config: AnchorShape): LedOnEdge {
  const edge = edgeOfAnchor(config.startAnchor);
  const n = config.counts[edge];
  if (config.startLocalIndex !== undefined && n > 0) return { edge, k: Math.min(config.startLocalIndex, n - 1) };
  const endpoint = endpointOfAnchor(config.startAnchor);
  if (endpoint === "start") return { edge, k: 0 };
  if (endpoint === "end") return { edge, k: Math.max(0, n - 1) };
  const side = endpoint === "gap-right" ? "right" : "left";
  return { edge, k: resolveBottomGapAnchorLocalIndex(n, config.bottomMissing, side) };
}

/**
 * The saved form of LED #1: the edge's anchor alone when one names that LED,
 * else the nearest anchor on the edge plus the index — so a build that does
 * not know `startLocalIndex` starts as close as it can.
 */
export function anchorForLed(
  counts: LedCalibrationConfig["counts"],
  bottomMissing: number,
  led: LedOnEdge,
): Pick<LedCalibrationConfig, "startAnchor" | "startLocalIndex"> {
  const n = counts[led.edge];
  const k = Math.max(0, Math.min(led.k, n - 1));
  const candidates: Array<[AnchorEndpoint, number]> = [
    ["start", 0],
    ["end", Math.max(0, n - 1)],
  ];
  if (led.edge === "bottom" && bottomMissing > 0) {
    candidates.push(
      ["gap-right", resolveBottomGapAnchorLocalIndex(n, bottomMissing, "right")],
      ["gap-left", resolveBottomGapAnchorLocalIndex(n, bottomMissing, "left")],
    );
  }
  const exact = candidates.find(([, at]) => at === k);
  if (exact) return { startAnchor: anchorFromEdgeEndpoint(led.edge, exact[0]) };
  const nearest = [...candidates].sort((a, b) => Math.abs(a[1] - k) - Math.abs(b[1] - k))[0]?.[0] ?? "start";
  return { startAnchor: anchorFromEdgeEndpoint(led.edge, nearest), startLocalIndex: k };
}
