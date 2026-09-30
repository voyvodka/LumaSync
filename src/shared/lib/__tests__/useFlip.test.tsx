import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useFlip } from "../useFlip";

const reduced = vi.hoisted(() => ({ on: false }));
vi.mock("../motion", () => ({ prefersReducedMotion: () => reduced.on }));

/** Each item stands 40px under the one before it, wherever the DOM has put it. */
function List({
  ids,
  aliases,
  resize,
  exits,
}: { ids: string[]; aliases?: Map<string, string>; resize?: boolean; exits?: boolean }) {
  const ref = useRef<HTMLUListElement | null>(null);
  useFlip(ref, ids, { aliases, resize, exits });
  return (
    <ul ref={ref}>
      {ids.map((id) => (
        <li key={id} data-flip-id={id} data-testid={`item-${id}`}>
          {id}
        </li>
      ))}
    </ul>
  );
}

const animate = vi.fn<(keyframes: Keyframe[], options: KeyframeAnimationOptions) => Partial<Animation>>(() => ({}));

function place() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.tagName === "UL") return { left: 0, top: 0, height: this.children.length * 40 } as DOMRect;
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

  it("sends an item that changed identity from its old self's place, marked while it travels", () => {
    place();
    const view = render(<List ids={["a", "s-x", "b"]} />);
    view.rerender(<List ids={["a", "x", "b"]} aliases={new Map([["x", "s-x"]])} />);
    // "x" took "s-x"'s place exactly: nothing to move.
    expect(animate).not.toHaveBeenCalled();
    view.rerender(<List ids={["x", "a", "b"]} aliases={new Map([["y", "a"]])} />);
    expect(animate).toHaveBeenCalledTimes(2);

    animate.mockClear();
    const travel = render(<List ids={["a", "b", "s-y"]} />);
    travel.rerender(<List ids={["y", "a", "b"]} aliases={new Map([["y", "s-y"]])} />);
    const y = travel.container.querySelector('[data-flip-id="y"]')!;
    expect(animate.mock.contexts).toContain(y);
    expect(y).toHaveAttribute("data-flip-travelling");
  });

  it("lets the container's height follow when asked", () => {
    place();
    const view = render(<List ids={["a", "b"]} resize />);
    view.rerender(<List ids={["a"]} resize />);
    const ul = view.container.querySelector("ul")!;
    const call = animate.mock.calls[animate.mock.contexts.indexOf(ul)];
    expect(call?.[0]).toEqual([{ height: "80px" }, { height: "40px" }]);
  });

  it("fades an item that is gone out where it stood, as an unnamed, inert copy that then goes", () => {
    vi.useFakeTimers();
    place();
    const view = render(<List ids={["a", "b", "c"]} exits />);
    view.rerender(<List ids={["a", "c"]} exits />);
    const ghost = view.container.querySelector<HTMLElement>("li[aria-hidden='true']")!;
    expect(ghost.textContent).toBe("b");
    expect(ghost).toHaveAttribute("inert");
    expect(ghost).not.toHaveAttribute("data-flip-id");
    expect(ghost).not.toHaveAttribute("data-testid");
    expect(ghost.style.position).toBe("absolute");
    expect(ghost.style.top).toBe("40px");
    expect(animate).toHaveBeenCalledWith([{ opacity: 1 }, { opacity: 0 }], expect.objectContaining({ fill: "forwards" }));
    vi.advanceTimersByTime(200);
    expect(ghost.isConnected).toBe(false);
    vi.useRealTimers();
  });

  it("leaves no copy without being asked, nor under reduced motion", () => {
    place();
    const view = render(<List ids={["a", "b"]} />);
    view.rerender(<List ids={["a"]} />);
    expect(view.container.querySelectorAll("li")).toHaveLength(1);
    reduced.on = true;
    const again = render(<List ids={["a", "b"]} exits />);
    again.rerender(<List ids={["a"]} exits />);
    expect(again.container.querySelectorAll("li")).toHaveLength(1);
  });
});
