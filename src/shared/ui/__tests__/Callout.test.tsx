import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Callout } from "../Callout";

describe("Callout", () => {
  it("announces an error as an alert and prefixes its severity for screen readers", () => {
    render(<Callout tone="error">The strip did not answer.</Callout>);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The strip did not answer.");
    expect(alert.querySelector(".sr-only")?.textContent).toMatch(/^common:callout\.tone\.error: $|^Error: $/);
  });

  it.each(["warning", "info", "ok"] as const)("announces a %s politely", (tone) => {
    render(<Callout tone={tone}>Saved.</Callout>);
    expect(screen.getByRole("status")).toHaveClass(`is-${tone}`);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stays silent inside a container that is already the live region", () => {
    render(
      <Callout tone="error" announce={false}>
        Quiet.
      </Callout>,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Quiet.")).toBeInTheDocument();
  });

  it("offers one text-link action, busy while it runs", async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Callout tone="warning" action={{ label: "Retry", onClick }}>
        Saved to the app only.
      </Callout>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Callout tone="warning" action={{ label: "Retry", onClick, pending: true }}>
        Saved to the app only.
      </Callout>,
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry" })).toHaveAttribute("aria-busy", "true");
  });
});
