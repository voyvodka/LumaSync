import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CarryHint } from "../CarryHint";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const shown = () => Array.from(screen.getByTestId("carry-hint").firstElementChild!.children).find((face) => !face.hasAttribute("aria-hidden"));

describe("CarryHint", () => {
  it("shows the keys the selected piece answers to, and nothing without one", () => {
    const { rerender } = render(<CarryHint hint="turn" />);
    expect(shown()).toHaveTextContent("RroomMap:carryHint.turn");
    rerender(<CarryHint hint="rise" />);
    expect(shown()).toHaveTextContent("roomMap:carryHint.rise");
    expect(shown()).toHaveTextContent("roomMap:carryHint.letGo");
    rerender(<CarryHint hint={null} />);
    expect(shown()).toBeEmptyDOMElement();
  });

  it("names the key that moves a piece without snapping, only while it snaps", () => {
    const { rerender } = render(<CarryHint hint="turn" free />);
    expect(shown()).toHaveTextContent("roomMap:carryHint.free");
    rerender(<CarryHint hint="turn" />);
    expect(shown()).not.toHaveTextContent("roomMap:carryHint.free");
  });
});
