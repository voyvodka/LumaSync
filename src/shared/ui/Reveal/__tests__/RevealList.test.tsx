import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RevealList } from "../RevealList";

const list = (items: string[]) => (
  <RevealList items={items} keyOf={(item) => item}>
    {(item) => <span>{item}</span>}
  </RevealList>
);

const rowOf = (text: string) => screen.getByText(text).closest("[data-reveal]");

afterEach(() => {
  vi.useRealTimers();
});

describe("RevealList", () => {
  it("what the page opened on is already in place", () => {
    render(list(["a", "b"]));
    expect(rowOf("a")).toHaveAttribute("data-open", "true");
    expect(rowOf("b")).toHaveAttribute("data-open", "true");
  });

  it("a row that leaves closes where it stood, then goes", () => {
    vi.useFakeTimers();
    const { rerender, container } = render(list(["a", "b", "c"]));
    rerender(list(["a", "c"]));

    const rows = [...container.querySelectorAll("[data-reveal]")];
    expect(rows.map((row) => row.textContent)).toEqual(["a", "b", "c"]);
    expect(rowOf("b")).toHaveAttribute("data-open", "false");

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByText("b")).toBeNull();
  });

  // A caller's fresh array each render must not look like a change.
  it("a new array with the same keys changes nothing", () => {
    const { rerender, container } = render(list(["a", "b"]));
    rerender(list(["a", "b"]));
    expect(container.querySelectorAll("[data-reveal]")).toHaveLength(2);
    expect(rowOf("b")).toHaveAttribute("data-open", "true");
  });

  it("a row that arrives later grows in", () => {
    const { rerender } = render(list(["a"]));
    rerender(list(["a", "b"]));
    // Mounted closed, opened on the next frame: that is the growing in.
    expect(rowOf("b")).toHaveAttribute("data-open", "false");
  });
});

describe("RevealList — two leaving a moment apart", () => {
  it("keeps the order they stood in", () => {
    vi.useFakeTimers();
    const { rerender, container } = render(list(["a", "b", "c", "d"]));
    rerender(list(["a", "c", "d"]));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender(list(["a", "c"]));
    const order = [...container.querySelectorAll("[data-reveal]")].map((row) => row.textContent);
    expect(order).toEqual(["a", "b", "c", "d"]);
  });
});
