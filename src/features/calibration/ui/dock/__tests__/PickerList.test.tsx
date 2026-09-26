import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { PickerList } from "../PickerList";

describe("PickerList", () => {
  it("moves the selection to the picked row first and hands the pick over after it lands", () => {
    vi.useFakeTimers();
    const onPick = vi.fn<(i: number) => void>();
    const anchor = createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={anchor} type="button">anchor</button>
        <PickerList
          open
          onClose={() => {}}
          anchorRef={anchor}
          id="list"
          label="places"
          items={["Top-left", "Top-right", "Bottom-right"]}
          itemKey={(s) => s}
          renderItem={(s) => s}
          selectedIndex={0}
          onPick={onPick}
        />
      </>,
    );
    act(() => screen.getByRole("option", { name: "Bottom-right" }).click());

    expect(screen.getByRole("option", { name: "Bottom-right" })).toHaveAttribute("aria-selected", "true");
    expect(onPick).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(onPick).toHaveBeenCalledWith(2);
    vi.useRealTimers();
  });

  it("takes a pick back when the list is closed before it lands", () => {
    vi.useFakeTimers();
    const onPick = vi.fn<(i: number) => void>();
    const anchor = createRef<HTMLButtonElement>();
    const list = (open: boolean) => (
      <>
        <button ref={anchor} type="button">anchor</button>
        <PickerList
          open={open}
          onClose={() => {}}
          anchorRef={anchor}
          id="list"
          label="places"
          items={["Top-left", "Top-right"]}
          itemKey={(s) => s}
          renderItem={(s) => s}
          selectedIndex={0}
          onPick={onPick}
        />
      </>
    );
    const { rerender } = render(list(true));
    act(() => screen.getByRole("option", { name: "Top-right" }).click());
    rerender(list(false));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onPick).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
