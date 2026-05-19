/**
 * RoomMapToolbar — unit tests
 *
 * The original ROOM-06 "TV button disables after one TV is placed" stub was
 * misattributed: the TV add button lives in LeftToolbar (hasTv prop), not in
 * RoomMapToolbar. That test has been moved to LeftToolbar.test.tsx.
 *
 * This file covers RoomMapToolbar's own behaviour (undo/redo gate, derive
 * zones disabled state, settings toggle).
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
    const undoBtn = screen.getByRole("button", { name: "roomMap.toolbar.undo" });
    expect(undoBtn).toHaveAttribute("aria-disabled", "true");
  });

  it("undo button is enabled when canUndo is true", () => {
    const onUndo = vi.fn();
    render(<RoomMapToolbar {...BASE_PROPS} canUndo={true} onUndo={onUndo} />);
    const undoBtn = screen.getByRole("button", { name: "roomMap.toolbar.undo" });
    expect(undoBtn).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(undoBtn);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("redo button is disabled when canRedo is false", () => {
    render(<RoomMapToolbar {...BASE_PROPS} canUndo={false} canRedo={false} />);
    const redoBtn = screen.getByRole("button", { name: "roomMap.toolbar.redo" });
    expect(redoBtn).toHaveAttribute("aria-disabled", "true");
  });

  it("derive zones button is disabled when neither TV nor USB is present", () => {
    render(<RoomMapToolbar {...BASE_PROPS} hasTv={false} hasUsb={false} />);
    const deriveBtn = screen.getByRole("button", { name: "roomMap.zones.deriveButton" });
    expect(deriveBtn).toHaveAttribute("aria-disabled", "true");
  });

  it("derive zones button is enabled when both TV and USB are present", () => {
    const onDeriveZones = vi.fn();
    render(
      <RoomMapToolbar
        {...BASE_PROPS}
        hasTv={true}
        hasUsb={true}
        onDeriveZones={onDeriveZones}
      />,
    );
    const deriveBtn = screen.getByRole("button", { name: "roomMap.zones.deriveButton" });
    expect(deriveBtn).not.toBeDisabled();
    fireEvent.click(deriveBtn);
    expect(onDeriveZones).toHaveBeenCalledTimes(1);
  });

  it("settings button toggles aria-pressed and calls onToggleSettings", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <RoomMapToolbar settingsOpen={false} onToggleSettings={onToggle} />,
    );
    const settingsBtn = screen.getByRole("button", {
      name: "roomMap.toolbar.settingsAriaLabel",
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
});
