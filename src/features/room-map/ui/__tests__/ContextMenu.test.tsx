import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ContextMenu, type ContextMenuAction } from "../ContextMenu";

const ACTIONS: ContextMenuAction[] = [
  { label: "Duplicate", onClick: vi.fn<() => void>() },
  { label: "Rename", onClick: vi.fn<() => void>(), disabled: true },
  { label: "Delete", onClick: vi.fn<() => void>(), danger: true },
];

/** The editor root the menu opens over, with a toggle standing in for right-click. */
function Harness({ actions = ACTIONS }: { actions?: ContextMenuAction[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="root" tabIndex={0}>
      <button type="button" data-testid="open" onClick={() => setOpen(true)} />
      {open && <ContextMenu x={10} y={10} actions={actions} onClose={() => setOpen(false)} />}
    </div>
  );
}

function openFromRoot() {
  render(<Harness />);
  const root = screen.getByTestId("root");
  root.focus();
  act(() => {
    // Opened by the mouse, as right-click does: focus stays on the root.
    fireEvent.click(screen.getByTestId("open"));
  });
  return root;
}

describe("ContextMenu", () => {
  it("moves focus to the first item when it opens", () => {
    openFromRoot();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Duplicate" }));
  });

  it("walks the items with the arrows, skipping a disabled one and wrapping", () => {
    openFromRoot();
    const menu = screen.getByRole("menu");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Duplicate" }));
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Duplicate" }));
  });

  it("draws nothing when the object has no action", () => {
    render(<ContextMenu x={10} y={10} actions={[]} onClose={vi.fn<() => void>()} />);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the items out of the tab order", () => {
    openFromRoot();
    for (const item of screen.getAllByRole("menuitem")) {
      expect(item).toHaveAttribute("tabindex", "-1");
    }
  });

  it("closes on Escape and gives focus back to where it was", () => {
    const root = openFromRoot();

    act(() => {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(root);
  });

  it("closes on Tab instead of walking out of the menu", () => {
    const root = openFromRoot();

    act(() => {
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(root);
  });

  it("gives focus back after an item runs", () => {
    const root = openFromRoot();

    act(() => {
      screen.getByRole("menuitem", { name: "Delete" }).click();
    });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(root);
  });
});
