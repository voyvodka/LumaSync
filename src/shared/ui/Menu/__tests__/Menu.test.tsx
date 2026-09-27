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

  // A confirmation floats beside "…" instead of covering the page; the action waits for yes.
  it("asks beside … for an item that confirms, and runs it only on yes", () => {
    const trigger = () => screen.getByRole("button", { name: "More" });
    const forget = vi.fn<() => void>();
    render(
      <Menu
        label="More"
        items={[
          {
            id: "forget",
            label: "Forget",
            onSelect: forget,
            danger: true,
            confirm: { text: "Forget it?", confirmLabel: "Forget", cancelLabel: "Keep", testId: "ask" },
          },
        ]}
      />,
    );

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(forget).not.toHaveBeenCalled();
    const question = screen.getByTestId("ask");
    expect(question).toHaveTextContent("Forget it?");
    // Letting something go starts on the safe answer.
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(forget).not.toHaveBeenCalled();
    expect(trigger()).toHaveFocus();

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    const forgets = screen.getAllByRole("button", { name: "Forget" });
    const yes = forgets[forgets.length - 1]!;
    fireEvent.click(yes);
    expect(forget).toHaveBeenCalledOnce();
  });
});

