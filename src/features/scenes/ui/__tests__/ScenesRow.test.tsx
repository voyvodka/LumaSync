import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScenesRow, type SceneChip } from "../ScenesRow";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const chips: SceneChip[] = ["a", "b", "c", "d"].map((id) => ({ id, name: id, swatch: "red", active: false }));

/** The list is 200 px wide with 500 px of chips: it scrolls. */
function overflowing() {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(500);
}

afterEach(() => vi.restoreAllMocks());

describe("ScenesRow", () => {
  it("fades only the edges that have more past them", () => {
    overflowing();
    render(<ScenesRow scenes={chips} onPick={() => {}} />);
    const list = screen.getByRole("radiogroup");
    expect(list).toHaveAttribute("data-more", "end");
    list.scrollLeft = 100;
    fireEvent.scroll(list);
    expect(list).toHaveAttribute("data-more", "both");
    list.scrollLeft = 300;
    fireEvent.scroll(list);
    expect(list).toHaveAttribute("data-more", "start");
  });

  it("fades nothing when every chip fits", () => {
    render(<ScenesRow scenes={chips} onPick={() => {}} />);
    expect(screen.getByRole("radiogroup")).not.toHaveAttribute("data-more");
  });

  it("turns a vertical wheel into a sideways scroll while the chips overflow", () => {
    overflowing();
    render(<ScenesRow scenes={chips} onPick={() => {}} />);
    const list = screen.getByRole("radiogroup");
    const wheel = new WheelEvent("wheel", { deltaY: 60, cancelable: true });
    list.dispatchEvent(wheel);
    expect(list.scrollLeft).toBe(60);
    expect(wheel.defaultPrevented).toBe(true);
  });
});
