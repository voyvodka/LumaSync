import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SpinSwap } from "../SpinSwap";

const turn = (v: "cw" | "ccw") => v;
const icon = (v: string) => <i data-testid={`icon-${v}`} />;

describe("SpinSwap", () => {
  it("turns the old icon away and the new one in, then keeps only the new one", () => {
    const { rerender } = render(<SpinSwap value="cw" turn={turn} render={icon} />);
    rerender(<SpinSwap value="ccw" turn={turn} render={icon} />);

    const leaving = screen.getByTestId("icon-cw").parentElement!;
    expect(leaving).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("icon-ccw")).toBeInTheDocument();

    fireEvent.animationEnd(leaving);
    expect(screen.queryByTestId("icon-cw")).toBeNull();
  });
});
