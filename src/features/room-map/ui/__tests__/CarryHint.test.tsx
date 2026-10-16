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
    expect(shown()).toHaveTextContent("roomMap:carryHint.putBack");
    rerender(<CarryHint hint={null} />);
    expect(shown()).toBeEmptyDOMElement();
  });
});
