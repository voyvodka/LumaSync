/**
 * RoomMapToolbar — unit tests
 *
 * The original ROOM-06 "TV button disables after one TV is placed" stub was
 * misattributed: the TV add button lives in LeftToolbar (hasTv prop), not in
 * RoomMapToolbar. That test has been moved to LeftToolbar.test.tsx.
 *
 * This file covers RoomMapToolbar's own behaviour (undo/redo gate, settings
 * toggle).
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { RoomMapToolbar } from "../RoomMapToolbar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const BASE_PROPS = {
  settingsOpen: false,
  onToggleSettings: vi.fn(),
};

describe("RoomMapToolbar", () => {
  it("undo button is disabled when canUndo is false", () => {
    render(<RoomMapToolbar {...BASE_PROPS} canUndo={false} canRedo={false} />);
    const undoBtn = screen.getByRole("button", { name: "roomMap:toolbar.undo" });
    expect(undoBtn).toHaveAttribute("aria-disabled", "true");
  });

  it("undo button is enabled when canUndo is true", () => {
    const onUndo = vi.fn();
    render(<RoomMapToolbar {...BASE_PROPS} canUndo={true} onUndo={onUndo} />);
    const undoBtn = screen.getByRole("button", { name: "roomMap:toolbar.undo" });
    expect(undoBtn).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(undoBtn);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("redo button is disabled when canRedo is false", () => {
    render(<RoomMapToolbar {...BASE_PROPS} canUndo={false} canRedo={false} />);
    const redoBtn = screen.getByRole("button", { name: "roomMap:toolbar.redo" });
    expect(redoBtn).toHaveAttribute("aria-disabled", "true");
  });

  it("settings button toggles aria-pressed and calls onToggleSettings", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <RoomMapToolbar settingsOpen={false} onToggleSettings={onToggle} />,
    );
    const settingsBtn = screen.getByRole("button", {
      name: "roomMap:toolbar.settingsAriaLabel",
    });
    expect(settingsBtn).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(settingsBtn);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<RoomMapToolbar settingsOpen={true} onToggleSettings={onToggle} />);
    expect(settingsBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("zone count badge is not rendered when zoneCount is 0", () => {
    render(<RoomMapToolbar {...BASE_PROPS} zoneCount={0} />);
    expect(document.querySelector(".lm-room-toolbar-badge")).toBeNull();
  });

  it("zone count badge shows count when zoneCount > 0", () => {
    render(<RoomMapToolbar {...BASE_PROPS} zoneCount={3} />);
    const badge = document.querySelector(".lm-room-toolbar-badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("3");
  });

  it("renders no room-aware chip unless room-aware is on", () => {
    render(<RoomMapToolbar {...BASE_PROPS} />);
    expect(
      screen.queryByRole("button", { name: "roomMap:roomAware.ariaLabel" }),
    ).not.toBeInTheDocument();
  });

  it("room-aware chip reads paused, with the Hue reason, when Hue cannot stream", () => {
    render(
      <RoomMapToolbar
        {...BASE_PROPS}
        roomAware={{ state: "paused", reason: "keyRejected" }}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "roomMap:roomAware.ariaLabel" }),
    ).not.toBeInTheDocument();
    const chip = screen.getByRole("button", { name: "roomMap:roomAware.pausedAriaLabel" });
    expect(chip).toHaveTextContent("roomMap:roomAware.pausedLabel");
    fireEvent.click(chip);
    const panel = document.getElementById(chip.getAttribute("aria-controls") ?? "");
    expect(panel).toHaveTextContent("roomMap:roomAware.paused.keyRejected");
    expect(panel).toHaveTextContent("roomMap:roomAware.pausedWhy");
    expect(panel).not.toHaveTextContent("roomMap:roomAware.why");
  });

  // A disclosure rather than a hover tooltip, so the explanation is reachable
  // from the keyboard; Escape must close it without reaching the editor's own
  // Escape (deselect).
  it("room-aware chip discloses its explanation and closes on Escape", () => {
    const onEditorKey = vi.fn();
    render(
      <div onKeyDown={onEditorKey}>
        <RoomMapToolbar {...BASE_PROPS} roomAware={{ state: "active" }} />
      </div>,
    );
    const chip = screen.getByRole("button", { name: "roomMap:roomAware.ariaLabel" });
    expect(chip).toHaveTextContent("roomMap:roomAware.label");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("roomMap:roomAware.body")).not.toBeVisible();

    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    const panel = document.getElementById(chip.getAttribute("aria-controls") ?? "");
    expect(panel).toBeVisible();
    expect(panel).toHaveTextContent("roomMap:roomAware.body");

    fireEvent.keyDown(chip, { key: "Escape" });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(onEditorKey).not.toHaveBeenCalled();
  });
});
