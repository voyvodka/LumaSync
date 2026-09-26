import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { Popover } from "../Popover";

function setup(open: boolean, onClose = vi.fn<() => void>()) {
  const anchor = createRef<HTMLButtonElement>();
  const view = render(
    <>
      <button ref={anchor} type="button">anchor</button>
      <Popover open={open} onClose={onClose} anchorRef={anchor} role="listbox" label="places">
        <span>inside</span>
      </Popover>
    </>,
  );
  return { anchor, onClose, view };
}

describe("Popover", () => {
  it("closes on Esc and on a press outside, not on a press inside", () => {
    const { onClose } = setup(true);
    fireEvent.pointerDown(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("stays for its exit after closing, then goes (animationend or the fallback)", () => {
    vi.useFakeTimers();
    const anchor = createRef<HTMLButtonElement>();
    const onClose = vi.fn<() => void>();
    const ui = (open: boolean) => (
      <>
        <button ref={anchor} type="button">anchor</button>
        <Popover open={open} onClose={onClose} anchorRef={anchor} role="listbox" label="places">
          <span>inside</span>
        </Popover>
      </>
    );
    const { rerender } = render(ui(true));
    rerender(ui(false));
    expect(screen.getByRole("listbox", { hidden: true })).toHaveAttribute("aria-hidden", "true");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByRole("listbox", { hidden: true })).toBeNull();
    vi.useRealTimers();
  });
});
