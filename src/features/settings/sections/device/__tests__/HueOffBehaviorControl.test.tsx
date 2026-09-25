/**
 * The Hue page's "When you press Off" choice. Loading and saving belong to
 * `DeviceSection` (DeviceSection.test.tsx); this is the control itself.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HUE_OFF_BEHAVIOR } from "@/shared/contracts/hue";
import { HueOffBehaviorControl, type HueOffBehaviorControlProps } from "../HueOffBehaviorControl";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function option(name: string): HTMLElement {
  return screen.getByRole("radio", { name });
}

describe("HueOffBehaviorControl", () => {
  it("marks nothing until the saved value is known", () => {
    render(<HueOffBehaviorControl value={null} onChange={() => {}} />);

    expect(option("hue:offBehavior.turnOff")).toHaveAttribute("aria-checked", "false");
    expect(option("hue:offBehavior.restore")).toHaveAttribute("aria-checked", "false");
  });

  it("hands on a new pick and nothing for the one already chosen", () => {
    const onChange = vi.fn<HueOffBehaviorControlProps["onChange"]>();
    render(<HueOffBehaviorControl value={HUE_OFF_BEHAVIOR.TURN_OFF} onChange={onChange} />);
    expect(option("hue:offBehavior.turnOff")).toHaveAttribute("aria-checked", "true");

    fireEvent.click(option("hue:offBehavior.turnOff"));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(option("hue:offBehavior.restore"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(HUE_OFF_BEHAVIOR.RESTORE);
  });

  it("names the choice once and explains it", () => {
    render(<HueOffBehaviorControl value={HUE_OFF_BEHAVIOR.RESTORE} onChange={() => {}} />);

    const group = screen.getByRole("radiogroup", { name: "hue:offBehavior.title" });
    expect(group).toHaveAccessibleDescription("hue:offBehavior.description");
    expect(screen.getByText("hue:offBehavior.title")).toHaveAttribute("aria-hidden", "true");
  });
});
