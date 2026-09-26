import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AsyncToggle } from "../AsyncToggle";

const faces = { idle: "Test", on: "Stop", starting: "Starting…", stopping: "Stopping…" };

describe("AsyncToggle", () => {
  it("shows the waiting face in words, keeping what it said as the state arrives", () => {
    const props = { label: "Test", faces, onToggle: vi.fn<() => void>() };
    const { rerender } = render(<AsyncToggle on={false} waiting {...props} />);
    const shown = () => screen.getAllByText(/./).filter((el) => !el.closest("[aria-hidden]")).map((el) => el.textContent);

    expect(shown()).toContain("Starting…");
    expect(screen.getByRole("button", { name: "Test" })).toHaveAttribute("aria-busy", "true");
    rerender(<AsyncToggle on waiting={false} {...props} label="Stop" />);
    expect(shown()).toContain("Stop");
    // The fading wait face still reads "Starting…", not "Stopping…".
    expect(screen.queryByText("Stopping…")).toBeNull();
  });
});
