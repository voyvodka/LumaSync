import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useFlip } from "../useFlip";

const reduced = vi.hoisted(() => ({ on: false }));
vi.mock("../motion", () => ({ prefersReducedMotion: () => reduced.on }));

/** Each item stands 40px under the one before it, wherever the DOM has put it. */
function List({ ids }: { ids: string[] }) {
  const ref = useRef<HTMLUListElement | null>(null);
  useFlip(ref, ids);
  return (
    <ul ref={ref}>
      {ids.map((id) => (
        <li key={id} data-flip-id={id}>
          {id}
        </li>
      ))}
    </ul>
  );
}

const animate = vi.fn<(keyframes: Keyframe[], options: KeyframeAnimationOptions) => void>();

function place() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = [...(this.parentElement?.children ?? [])].indexOf(this);
    return { left: 0, top: index * 40 } as DOMRect;
  });
  (HTMLElement.prototype as unknown as { animate: typeof animate }).animate = animate;
}

afterEach(() => {
  vi.restoreAllMocks();
  animate.mockReset();
  reduced.on = false;
});

describe("useFlip", () => {
  it("slides a moved item from its old place, and leaves one that stayed alone", () => {
    place();
    const view = render(<List ids={["a", "b", "c"]} />);
    view.rerender(<List ids={["b", "a", "c"]} />);
    const moved = animate.mock.calls.map(([frames]) => frames[0]!.transform);
    // In the new order: "b" starts 40px lower, where it was, "a" 40px higher; "c" stayed at 80.
    expect(moved).toEqual(["translate(0px, 40px)", "translate(0px, -40px)"]);
  });

  it("moves nothing on the first render, for an item that is new, or under reduced motion", () => {
    place();
    const view = render(<List ids={["a", "b"]} />);
    expect(animate).not.toHaveBeenCalled();
    view.rerender(<List ids={["a", "b", "c"]} />);
    expect(animate).not.toHaveBeenCalled();
    reduced.on = true;
    view.rerender(<List ids={["c", "b", "a"]} />);
    expect(animate).not.toHaveBeenCalled();
  });
});
