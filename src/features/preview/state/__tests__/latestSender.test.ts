import { describe, expect, it, vi } from "vitest";

import { createLatestSender } from "../latestSender";

describe("createLatestSender", () => {
  it("sends the first value and then only the newest of those that came while it was in flight", async () => {
    const answers: Array<() => void> = [];
    const send = vi.fn((_value: number) => new Promise<void>((resolve) => answers.push(resolve)));
    const push = createLatestSender(send);

    push(1);
    push(2);
    push(3);
    expect(send.mock.calls.map(([value]) => value)).toEqual([1]);

    answers[0]();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][0]).toBe(3);
  });

  it("keeps sending after a failed send", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn<(value: number) => Promise<void>>().mockRejectedValueOnce(new Error("nope")).mockResolvedValue();
    const push = createLatestSender(send);

    push(1);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    push(2);

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  });
});
