/**
 * The Hue page's "When you press Off" choice. Loading and saving belong to
 * `DevicesPage` (DevicesPage.test.tsx); this is the control itself.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HUE_OFF_BEHAVIOR } from "@/shared/contracts/hue";
import { HueOffBehaviorRow, type HueOffBehaviorRowProps } from "../HueOffBehaviorRow";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function option(name: string): HTMLElement {
  return screen.getByRole("radio", { name });
}

describe("HueOffBehaviorRow", () => {
  it("marks nothing until the saved value is known", () => {
    render(<HueOffBehaviorRow value={null} onChange={() => {}} />);

    expect(option("hue:offBehavior.turnOff")).toHaveAttribute("aria-checked", "false");
    expect(option("hue:offBehavior.restore")).toHaveAttribute("aria-checked", "false");
  });

  it("hands on a new pick and nothing for the one already chosen", () => {
    const onChange = vi.fn<HueOffBehaviorRowProps["onChange"]>();
    render(<HueOffBehaviorRow value={HUE_OFF_BEHAVIOR.TURN_OFF} onChange={onChange} />);
    expect(option("hue:offBehavior.turnOff")).toHaveAttribute("aria-checked", "true");

    fireEvent.click(option("hue:offBehavior.turnOff"));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(option("hue:offBehavior.restore"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(HUE_OFF_BEHAVIOR.RESTORE);
  });

  it("names the choice, and keeps its explanation behind the row's ⓘ", () => {
    render(<HueOffBehaviorRow value={HUE_OFF_BEHAVIOR.RESTORE} onChange={() => {}} />);

    expect(screen.getByRole("radiogroup", { name: "hue:offBehavior.title" })).toBeInTheDocument();
    expect(screen.getByText("hue:row.offBehavior")).toBeInTheDocument();
    expect(screen.queryByText("hue:offBehavior.description")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "common:hintFor" }));
    expect(screen.getByText("hue:offBehavior.description")).toBeInTheDocument();
  });
});
