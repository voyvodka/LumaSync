import { describe, expect, it, vi } from "vitest";

import type { LightingTuning, RetuneLightingResult } from "@/shared/contracts/lightingRuntime";

import { createRetuneCoalescer } from "../retuneCoalescer";

const APPLIED: RetuneLightingResult = { status: { code: "RETUNE_APPLIED", message: "", details: null } };

/** A backend whose answers the test releases one at a time. */
function heldBackend() {
  const answers: Array<() => void> = [];
  const send = vi.fn(
    (_tuning: LightingTuning) =>
      new Promise<RetuneLightingResult>((resolve) => {
        answers.push(() => resolve(APPLIED));
      }),
  );
  const answerNext = async () => {
    answers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { send, answerNext };
}

const brightness = (value: number): LightingTuning => ({
  solid: { r: 10, g: 20, b: 30, brightness: value },
});

describe("createRetuneCoalescer", () => {
  // The storm this replaces: every drag commit was its own mode apply.
  it("sends the first and the last of a burst, never the ones in between", async () => {
    const { send, answerNext } = heldBackend();
    const retunes = createRetuneCoalescer(send);

    for (let i = 1; i <= 20; i += 1) retunes.push(brightness(i / 20));
    expect(send).toHaveBeenCalledTimes(1);

    await answerNext();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual(brightness(1));

    await answerNext();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not send a value equal to the last one, whatever its key order", async () => {
    const send = vi.fn().mockResolvedValue(APPLIED);
    const retunes = createRetuneCoalescer(send);

    retunes.push({ ambilight: { brightness: 0.5, saturation: 1 } });
    await Promise.resolve();
    await Promise.resolve();
    retunes.push({ ambilight: { saturation: 1, brightness: 0.5 } });
    await Promise.resolve();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drops the waiting value when the drag comes back to the one in flight", async () => {
    const { send, answerNext } = heldBackend();
    const retunes = createRetuneCoalescer(send);

    retunes.push(brightness(0.5));
    retunes.push(brightness(0.7));
    retunes.push(brightness(0.5));
    await answerNext();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends an equal value again after a kind change reset it", async () => {
    const send = vi.fn().mockResolvedValue(APPLIED);
    const retunes = createRetuneCoalescer(send);

    retunes.push(brightness(0.5));
    await Promise.resolve();
    await Promise.resolve();
    retunes.reset();
    retunes.push(brightness(0.5));

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps going after a failed send", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn().mockRejectedValueOnce(new Error("lost")).mockResolvedValue(APPLIED);
    const retunes = createRetuneCoalescer(send);

    retunes.push(brightness(0.2));
    retunes.push(brightness(0.3));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][0]).toEqual(brightness(0.3));
  });
});
