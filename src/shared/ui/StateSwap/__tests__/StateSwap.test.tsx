import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StateSwap } from "../StateSwap";

describe("StateSwap", () => {
  it("keeps every face mounted and makes only the one on show reachable", () => {
    const faces = { rest: <span>Saved</span>, ready: <button type="button">Save</button> };
    const { rerender } = render(<StateSwap state="rest" faces={faces} />);

    expect(screen.getByText("Saved").parentElement).not.toHaveAttribute("inert");
    expect(screen.getByText("Save").parentElement).toHaveAttribute("inert");

    rerender(<StateSwap state="ready" faces={faces} />);

    expect(screen.getByText("Saved").parentElement).toHaveAttribute("inert");
    expect(screen.getByText("Save").parentElement).not.toHaveAttribute("inert");
  });
});
