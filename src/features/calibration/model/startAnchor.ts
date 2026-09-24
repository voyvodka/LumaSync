import type { LedStartAnchor } from "./contracts";

export type AnchorEdge = "top" | "right" | "bottom" | "left";
export type AnchorEndpoint = "start" | "end" | "gap-right" | "gap-left";

export function edgeOfAnchor(anchor: LedStartAnchor): AnchorEdge {
  if (anchor.startsWith("top")) return "top";
  if (anchor.startsWith("right")) return "right";
  if (anchor.startsWith("bottom")) return "bottom";
  return "left";
}

export function endpointOfAnchor(anchor: LedStartAnchor): AnchorEndpoint {
  if (anchor === "bottom-gap-right") return "gap-right";
  if (anchor === "bottom-gap-left") return "gap-left";
  return anchor.endsWith("-end") ? "end" : "start";
}

export function anchorFromEdgeEndpoint(edge: AnchorEdge, endpoint: AnchorEndpoint): LedStartAnchor {
  if (endpoint === "gap-right") return "bottom-gap-right";
  if (endpoint === "gap-left") return "bottom-gap-left";
  return `${edge}-${endpoint}` as LedStartAnchor;
}
