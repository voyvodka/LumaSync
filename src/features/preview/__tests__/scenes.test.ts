import { describe, expect, it } from "vitest";

import { SCENE_KINDS } from "@/shared/contracts/preview";

import {
  EDGE_TOUR_LOOP_MS,
  SCENE_RENDERERS,
  edgeTourPosition,
  letterboxPictureHeight,
} from "../scenes";

/** A 2D context that records what is drawn, so two draws can be compared. */
function recordingContext() {
  const calls: string[] = [];
  const gradient = () => ({ addColorStop: (offset: number, color: string) => calls.push(`stop ${offset} ${color}`) });
  const ctx = new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name === "createLinearGradient" || name === "createRadialGradient") {
          return (...args: number[]) => {
            calls.push(`${name} ${args.join(",")}`);
            return gradient();
          };
        }
        return (...args: unknown[]) => calls.push(`${name} ${args.join(",")}`);
      },
      set: (_target, name: string, value: unknown) => {
        calls.push(`${name}=${typeof value === "object" ? "gradient" : String(value)}`);
        return true;
      },
    },
  ) as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe("scene renderers", () => {
  it("has one for every scene the popup offers", () => {
    expect(Object.keys(SCENE_RENDERERS).sort()).toEqual([...SCENE_KINDS].sort());
  });

  // A run must be repeatable: the same moment draws the same frame.
  it.each(SCENE_KINDS)("%s draws the same frame for the same moment", (kind) => {
    const first = recordingContext();
    const second = recordingContext();
    SCENE_RENDERERS[kind](first.ctx, 1920, 1080, 4321);
    SCENE_RENDERERS[kind](second.ctx, 1920, 1080, 4321);
    expect(first.calls.length).toBeGreaterThan(0);
    expect(second.calls).toEqual(first.calls);
  });

  it.each(SCENE_KINDS)("%s moves with time", (kind) => {
    const early = recordingContext();
    const later = recordingContext();
    SCENE_RENDERERS[kind](early.ctx, 1920, 1080, 1000);
    SCENE_RENDERERS[kind](later.ctx, 1920, 1080, 1600);
    expect(later.calls).not.toEqual(early.calls);
  });
});

describe("edge tour", () => {
  const W = 1600;
  const H = 900;
  const perimeter = 2 * (W + H);
  const at = (distance: number) => (distance / perimeter) * EDGE_TOUR_LOOP_MS;

  it("starts at the top-left corner and runs clockwise", () => {
    expect(edgeTourPosition(W, H, 0)).toEqual({ edge: "top", along: 0 });
    expect(edgeTourPosition(W, H, at(W / 2))).toEqual({ edge: "top", along: 0.5 });
    expect(edgeTourPosition(W, H, at(W + H / 2))).toEqual({ edge: "right", along: 0.5 });
    expect(edgeTourPosition(W, H, at(W + H + W / 4))).toEqual({ edge: "bottom", along: 0.25 });
    expect(edgeTourPosition(W, H, at(2 * W + H + H * 0.75))).toEqual({ edge: "left", along: 0.75 });
  });

  it("comes round again after a loop", () => {
    expect(edgeTourPosition(W, H, EDGE_TOUR_LOOP_MS + at(W / 2))).toEqual({ edge: "top", along: 0.5 });
  });
});

describe("letterbox", () => {
  it("leaves bars above and below a 16:9 display", () => {
    expect(letterboxPictureHeight(2390, 1344)).toBe(1000);
  });

  it("fills a display already wider than the film", () => {
    expect(letterboxPictureHeight(3000, 1000)).toBe(1000);
  });
});
