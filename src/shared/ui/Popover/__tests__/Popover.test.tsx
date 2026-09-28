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

  // A list opened below a control near the window's foot would run off it: it opens above instead,
  // and below again where it fits.
  it.each([
    { anchorTop: 560, placed: /above/ },
    { anchorTop: 100, placed: /below/ },
  ])("opens below unless it would run off the window (anchor at $anchorTop)", ({ anchorTop, placed }) => {
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200);
    vi.stubGlobal("innerHeight", 620);
    const anchor = createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={anchor} type="button">anchor</button>
        <Popover open onClose={() => {}} anchorRef={anchor} side="below" role="listbox" label="places">
          <span>inside</span>
        </Popover>
      </>,
    );
    vi.spyOn(anchor.current!, "getBoundingClientRect").mockReturnValue(
      { top: anchorTop, bottom: anchorTop + 30, left: 100, right: 160, width: 60, height: 30, x: 100, y: anchorTop } as DOMRect,
    );
    // Placement is measured on open; reopen with the anchor where the test put it.
    height.mockClear();
    const view = render(
      <Popover open onClose={() => {}} anchorRef={anchor} side="below" role="dialog" label="again">
        <span>again</span>
      </Popover>,
    );
    expect(screen.getByRole("dialog").className).toMatch(placed);
    view.unmount();
    height.mockRestore();
    vi.unstubAllGlobals();
  });
});
