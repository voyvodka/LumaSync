import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChoiceThumb, type ChoiceThumb } from "../useChoiceThumb";

/** Where each option stands in its group, by test id; a resize moves them. */
const lefts: Record<string, number> = {};
let remeasure: () => void = () => {};
let seen: ChoiceThumb | null = null;

function Strip({ value }: { value: "a" | "b" }) {
  const strip = useRef<HTMLDivElement | null>(null);
  seen = useChoiceThumb(strip, value).thumb;
  return (
    <div ref={strip}>
      <div data-testid="group">
        <button role="radio" aria-checked={value === "a"} data-testid="a" />
        <button role="radio" aria-checked={value === "b"} data-testid="b" />
      </div>
    </div>
  );
}

beforeEach(() => {
  Object.assign(lefts, { a: 0, b: 100 });
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
    return lefts[this.dataset.testid ?? ""] ?? 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(80);
  // The test DOM leaves offsetParent undefined: the option's group is its positioned parent here.
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement;
    },
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        remeasure = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  seen = null;
});

describe("useChoiceThumb", () => {
  it("leads with the side the choice moved to, and a resize under the same choice keeps that side", () => {
    const view = render(<Strip value="b" />);
    expect(seen).toMatchObject({ left: 100, right: 20, toLeft: false });

    view.rerender(<Strip value="a" />);
    expect(seen).toMatchObject({ left: 0, toLeft: true });

    // A language switch widens what sits before "a": it moves right, but nobody chose anything.
    lefts.a = 12;
    act(() => remeasure());
    expect(seen).toMatchObject({ left: 12, toLeft: true });

    view.rerender(<Strip value="b" />);
    expect(seen).toMatchObject({ left: 100, toLeft: false });
  });
});
