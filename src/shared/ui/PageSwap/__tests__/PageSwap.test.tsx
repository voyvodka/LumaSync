import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageSwap } from "../PageSwap";

describe("PageSwap", () => {
  it("keeps the old content until its exit ends, then drops it", () => {
    const { rerender } = render(<PageSwap id="a" way="next">Top-left</PageSwap>);
    rerender(<PageSwap id="b" way="next">Top-right</PageSwap>);

    const leaving = screen.getByText("Top-left");
    expect(leaving).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Top-right")).toBeInTheDocument();

    fireEvent.animationEnd(leaving);
    expect(screen.queryByText("Top-left")).toBeNull();
  });

  it("does not page when only the content changes under the same id", () => {
    const { rerender } = render(<PageSwap id="a" way="next">One</PageSwap>);
    rerender(<PageSwap id="a" way="next">One, updated</PageSwap>);

    expect(screen.queryByText("One")).toBeNull();
    expect(screen.getByText("One, updated")).not.toHaveAttribute("aria-hidden");
  });
});
