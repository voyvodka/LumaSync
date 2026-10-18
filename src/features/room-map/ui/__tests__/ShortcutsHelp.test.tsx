import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ShortcutsHelp } from "../ShortcutsHelp";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const open = (room: boolean) => {
  render(<ShortcutsHelp room={room} />);
  fireEvent.click(screen.getByRole("button", { name: "roomMap:shortcuts.title" }));
  return screen.getByRole("dialog", { name: "roomMap:shortcuts.title" });
};

describe("ShortcutsHelp", () => {
  it("names ⇧-drag for height in the 3D room, and the plan's own drags only on the plan", () => {
    const room = open(true);
    expect(room).toHaveTextContent("roomMap:shortcuts.raise");
    expect(room).not.toHaveTextContent("roomMap:shortcuts.freeDrag");
  });

  it("leaves height out of the plan, which has none", () => {
    const plan = open(false);
    expect(plan).not.toHaveTextContent("roomMap:shortcuts.raise");
    expect(plan).toHaveTextContent("roomMap:shortcuts.freeDrag");
  });
});
