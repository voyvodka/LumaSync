import { describe, expect, it } from "vitest";

import { FURNITURE_DEFAULT_SIZE } from "../furnitureKinds";
import { dropRect, TV_DEFAULT_FOOTPRINT } from "../libraryDrop";

const room = { width: 4, depth: 3 };

describe("dropRect", () => {
  it("centres the card's piece on the point it is dropped at", () => {
    const sofa = FURNITURE_DEFAULT_SIZE.sofa;
    expect(dropRect({ kind: "furniture", type: "sofa" }, { x: 2, y: 1.5 }, room)).toEqual({
      x: 2 - sofa.width / 2,
      y: 1.5 - sofa.depth / 2,
      width: sofa.width,
      depth: sofa.depth,
    });
  });

  it("keeps a piece dropped at the wall inside the room", () => {
    const tv = dropRect({ kind: "tv" }, { x: 3.9, y: -0.4 }, room);
    expect(tv).toEqual({ x: 4 - TV_DEFAULT_FOOTPRINT.width, y: 0, ...TV_DEFAULT_FOOTPRINT });
  });
});
