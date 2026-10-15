import { describe, expect, it } from "vitest";

import { lightPickHalf, type Pickable, type PickRay, pickObject, rayBoxDistance } from "../picking";

const down = (x: number, z: number): PickRay => ({ origin: { x, y: 10, z }, direction: { x: 0, y: -1, z: 0 } });

const sofa: Pickable = { id: "furniture-sofa", kind: "furniture", centre: { x: 0, y: 0.4, z: 0 }, half: [1, 0.4, 0.45], angle: 0 };
const lampOnSofa: Pickable = { id: "hue-1", kind: "light", centre: { x: 0.5, y: 0.3, z: 0 }, half: [0.15, 0.15, 0.15], angle: 0 };

describe("rayBoxDistance", () => {
  it("measures to the top of a box below the ray", () => {
    expect(rayBoxDistance(down(0, 0), sofa)).toBeCloseTo(10 - 0.8);
  });

  it("misses beside the box", () => {
    expect(rayBoxDistance(down(1.2, 0), sofa)).toBeNull();
  });

  it("misses a box behind the ray's origin", () => {
    expect(rayBoxDistance({ origin: { x: 0, y: 10, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, sofa)).toBeNull();
  });

  it("turns the box as the plan turned the piece", () => {
    const turned: Pickable = { ...sofa, angle: Math.PI / 2 };
    // Long along x unturned; a quarter turn makes it long along z.
    expect(rayBoxDistance(down(0, 0.9), turned)).not.toBeNull();
    expect(rayBoxDistance(down(0.9, 0), turned)).toBeNull();
  });

  it("matches the placement's direction of turn", () => {
    // A box offset along its own +x; turned by +30°, the plan's -angle about y puts it at (cos, sin)·d.
    const angle = Math.PI / 6;
    const item: Pickable = { id: "x", kind: "furniture", centre: { x: 0, y: 0, z: 0 }, half: [2, 0.1, 0.05], angle };
    expect(rayBoxDistance(down(1.5 * Math.cos(angle), 1.5 * Math.sin(angle)), item)).not.toBeNull();
    expect(rayBoxDistance(down(1.5 * Math.cos(angle), -1.5 * Math.sin(angle)), item)).toBeNull();
  });
});

describe("pickObject", () => {
  it("picks a light the ray passes through over nearer furniture", () => {
    expect(pickObject(down(0.5, 0), [sofa, lampOnSofa])).toBe("hue-1");
  });

  it("picks the nearest piece when no light is hit", () => {
    const rug: Pickable = { id: "furniture-rug", kind: "furniture", centre: { x: 0, y: 0.005, z: 0 }, half: [1.5, 0.005, 1], angle: 0 };
    expect(pickObject(down(-0.5, 0), [rug, sofa, lampOnSofa])).toBe("furniture-sofa");
  });

  // An L-shaped strip was picked by the box round both legs, so a click in the L's open corner took it.
  it("picks a bent strip on its legs, not in the box round them", () => {
    const leg = (x: number, z: number, angle: number) => ({ centre: { x, y: 0.003, z }, half: [1, 0.002, 0.006] as const, angle });
    const bent: Pickable = {
      id: "usb-l",
      kind: "light",
      centre: { x: 0, y: 0.003, z: 0 },
      half: [1, 0.002, 1],
      angle: 0,
      line: true,
      legs: [leg(0, -1, 0), leg(-1, 0, Math.PI / 2)],
    };
    expect(pickObject(down(0.5, -1), [bent], 0.05)).toBe("usb-l");
    expect(pickObject(down(-1, 0.5), [bent], 0.05)).toBe("usb-l");
    expect(pickObject(down(0.5, 0.5), [bent], 0.05)).toBeNull();
  });

  it("picks nothing on empty ground", () => {
    expect(pickObject(down(5, 5), [sofa, lampOnSofa])).toBeNull();
  });
});

describe("lightPickHalf", () => {
  it("keeps a light 32 px across when the room is drawn small", () => {
    expect(lightPickHalf(50)).toBeCloseTo(16 / 50);
  });

  it("never drops below the room-size floor when zoomed in", () => {
    expect(lightPickHalf(400)).toBe(0.15);
    expect(lightPickHalf(0)).toBe(0.15);
  });

  it("widens a light's box, so a click just beside a bulb still picks it", () => {
    const bulb: Pickable = { id: "hue-2", kind: "light", centre: { x: 0, y: 1, z: 0 }, half: [0.055, 0.055, 0.055], angle: 0 };
    expect(pickObject(down(0.2, 0), [bulb])).toBeNull();
    expect(pickObject(down(0.2, 0), [bulb], lightPickHalf(50))).toBe("hue-2");
  });
});
