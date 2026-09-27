import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Reveal } from "../Reveal";

const root = () => document.querySelector("[data-reveal]") as HTMLElement;

describe("Reveal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens on its content with no motion when the page opens on it", () => {
    render(<Reveal open>note</Reveal>);
    expect(root()).toHaveAttribute("data-open", "true");
    expect(root()).not.toHaveAttribute("aria-hidden");
    expect(screen.getByText("note")).toBeInTheDocument();
  });

  // What arrives with motion leaves with it: the note stays for the exit, out of reach, then goes.
  it("keeps what it closed with until the motion ends, hidden and inert, then drops it", () => {
    const { rerender } = render(<Reveal open>note</Reveal>);
    rerender(<Reveal open={false}>{null}</Reveal>);

    expect(root()).toHaveAttribute("data-open", "false");
    expect(root()).toHaveAttribute("aria-hidden", "true");
    expect(root()).toHaveAttribute("inert");
    expect(root()).toHaveTextContent("note");

    const end = new Event("transitionend", { bubbles: true }) as TransitionEvent;
    Object.defineProperty(end, "propertyName", { value: "grid-template-rows" });
    act(() => {
      fireEvent(root(), end);
    });
    expect(root()).not.toHaveTextContent("note");
  });

  it("drops it on a timer where no transitionend comes", () => {
    const { rerender } = render(<Reveal open>note</Reveal>);
    rerender(<Reveal open={false}>{null}</Reveal>);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(root()).not.toHaveTextContent("note");
  });

  it("grows in when told to appear", () => {
    render(
      <Reveal open appear>
        found
      </Reveal>,
    );
    expect(root()).toHaveAttribute("data-open", "false");
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(root()).toHaveAttribute("data-open", "true");
  });

  it("draws a caller's live content, so what closes is current", () => {
    const { rerender } = render(<Reveal open>one</Reveal>);
    rerender(<Reveal open={false}>two</Reveal>);
    expect(root()).toHaveTextContent("two");
  });
});
