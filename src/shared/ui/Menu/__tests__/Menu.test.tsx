import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Menu } from "../Menu";

describe("Menu", () => {
  it("draws nothing when there is nothing behind it", () => {
    const { container } = render(<Menu label="More" items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens from …, focuses the first item, and closes with focus back on … before the action runs", () => {
    const trigger = () => screen.getByRole("button", { name: "More" });
    let focusedWhenRun: Element | null = null;
    const forget = vi.fn(() => {
      focusedWhenRun = document.activeElement;
    });
    render(
      <Menu
        label="More"
        items={[
          { id: "check", label: "Check again", onSelect: () => {}, disabled: true },
          { id: "forget", label: "Forget", onSelect: forget, danger: true },
        ]}
      />,
    );
    expect(trigger()).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "More" })).toBeInTheDocument();
    // The disabled one is skipped.
    expect(screen.getByRole("button", { name: "Forget" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(forget).toHaveBeenCalledOnce();
    expect(focusedWhenRun).toBe(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });
});
