import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { InfoTip } from "../InfoTip";

describe("InfoTip", () => {
  it("its own button opens and closes the explanation, and says which it is", () => {
    render(<InfoTip label="About Reduce motion">Less movement on screen.</InfoTip>);
    const button = screen.getByRole("button", { name: "About Reduce motion" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Less movement on screen.")).toBeNull();

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "About Reduce motion" });
    expect(button).toHaveAttribute("aria-controls", dialog.id);
    expect(dialog).toHaveTextContent("Less movement on screen.");

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).not.toHaveAttribute("aria-controls");
  });

  it("Esc closes it", () => {
    render(<InfoTip label="About">Text</InfoTip>);
    const button = screen.getByRole("button", { name: "About" });
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(button).toHaveAttribute("aria-expanded", "false");
  });
});
