import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useStableCallback, useStableHandlers } from "../useStableCallback";

describe("useStableCallback", () => {
  it("keeps one identity and calls the newest closure", () => {
    const { result, rerender } = renderHook(({ n }) => useStableCallback((x: number) => x + n), {
      initialProps: { n: 1 },
    });
    const first = result.current;
    expect(first(1)).toBe(2);

    rerender({ n: 10 });
    expect(result.current).toBe(first);
    expect(first(1)).toBe(11);
  });
});

describe("useStableHandlers", () => {
  it("keeps one bag whose members call the newest handlers", () => {
    const { result, rerender } = renderHook(
      ({ n }) =>
        useStableHandlers({
          add: (x: number) => x + n,
          label: () => `n=${n}`,
        }),
      { initialProps: { n: 1 } },
    );
    const bag = result.current;
    const add = bag.add;

    rerender({ n: 5 });
    expect(result.current).toBe(bag);
    expect(result.current.add).toBe(add);
    expect(add(1)).toBe(6);
    expect(bag.label()).toBe("n=5");
  });
});
