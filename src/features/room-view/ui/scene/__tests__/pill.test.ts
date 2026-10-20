import { afterEach, describe, expect, it, vi } from "vitest";

import { pillTexture } from "../pill";

const context = { font: "", fillStyle: "", textBaseline: "", measureText: (text: string) => ({ width: text.length * 10 }), beginPath() {}, arc() {}, fill() {}, fillText() {} };

describe("pillTexture", () => {
  afterEach(() => vi.restoreAllMocks());

  // A tag that grew ("stands at 0.45 m") was uploaded into the storage of its first, narrower size.
  it("lets go of the texture's storage when the text changes its width, and only then", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const pill = pillTexture(12, null, 600);
    const dispose = vi.spyOn(pill.texture, "dispose");
    pill.set("0.4 m");
    expect(dispose).not.toHaveBeenCalled();
    pill.set("0.5 m");
    expect(dispose).not.toHaveBeenCalled();
    pill.set("stands at 0.45 m");
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
