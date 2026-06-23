/**
 * LeftToolbar — ROOM-06 TV button disable test
 *
 * The original ROOM-06 stub was placed in RoomMapToolbar.test.tsx but the TV
 * add button lives here (LeftToolbar, hasTv prop). Moved to the correct file.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { LeftToolbar } from "../LeftToolbar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const BASE_PROPS = {
  hasTv: false,
  onAddTv: vi.fn(),
  onAddFurniture: vi.fn(),
  onAddUsb: vi.fn(),
  onAddHue: vi.fn(),
  onAddImage: vi.fn(),
};

describe("LeftToolbar", () => {
  // ROOM-06: TV button disables after one TV is placed on the map
  it("ROOM-06: TV add button is enabled when no TV exists and disabled after TV is placed", () => {
    const onAddTv = vi.fn();

    const { rerender } = render(
      <LeftToolbar {...BASE_PROPS} hasTv={false} onAddTv={onAddTv} />,
    );

    const tvBtn = screen.getByRole("button", { name: "roomMap.toolbar.addTv" });

    // Before TV placed: button is enabled and clickable
    expect(tvBtn).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(tvBtn);
    expect(onAddTv).toHaveBeenCalledTimes(1);

    // Simulate parent updating hasTv to true after placement
    rerender(<LeftToolbar {...BASE_PROPS} hasTv={true} onAddTv={onAddTv} />);

    // After TV placed: button must be disabled via aria-disabled
    expect(tvBtn).toHaveAttribute("aria-disabled", "true");
  });

  it("TV add button click is suppressed when already disabled (hasTv=true)", () => {
    const onAddTv = vi.fn();
    render(<LeftToolbar {...BASE_PROPS} hasTv={true} onAddTv={onAddTv} />);

    const tvBtn = screen.getByRole("button", { name: "roomMap.toolbar.addTv" });
    fireEvent.click(tvBtn);
    expect(onAddTv).not.toHaveBeenCalled();
  });
});
