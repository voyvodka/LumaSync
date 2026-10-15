import { describe, expect, it } from "vitest";

import { fanOutStacked } from "../stackFan";

const opts = { near: 10, radius: 14, spacing: 18 };

describe("fanOutStacked", () => {
  it("spreads lights on one spot around it, each apart from the next", () => {
    const fan = fanOutStacked(
      [0, 1, 2, 3].map((id) => ({ id, x: 100, y: 100 })),
      opts,
    );
    const placed = [0, 1, 2, 3].map((id) => ({ x: 100 + fan.get(id)!.dx, y: 100 + fan.get(id)!.dy }));
    expect(placed[0]!.y).toBeCloseTo(86);
    for (let i = 0; i < placed.length; i++) {
      const next = placed[(i + 1) % placed.length]!;
      expect(Math.hypot(next.x - placed[i]!.x, next.y - placed[i]!.y)).toBeGreaterThanOrEqual(18);
    }
  });

  it("leaves lone lights where they are", () => {
    const fan = fanOutStacked(
      [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 50, y: 0 },
      ],
      opts,
    );
    expect(fan.size).toBe(0);
  });
});
