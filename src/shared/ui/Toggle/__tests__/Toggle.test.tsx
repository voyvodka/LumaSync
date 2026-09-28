import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Toggle } from "../Toggle";

describe("Toggle", () => {
  it("is a named switch that reports and flips its state", async () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Launch at login" />);
    const toggle = screen.getByRole("switch", { name: "Launch at login" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("marks itself busy while its action runs", () => {
    render(<Toggle checked onChange={() => {}} label="Beta" busy disabled />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-busy", "true");
  });
});
