import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Rail, type RailItem } from "../Rail";

const item = (id: string): RailItem<string> => ({ id, label: id, testId: `row-${id}` });

const rail = (ids: string[]) => <Rail label="Devices" items={ids.map(item)} active="a" onSelect={() => {}} />;

describe("Rail — rows that come and go", () => {
  it("what the page opened on is in place; a row that arrives later slides in", () => {
    const { rerender } = render(rail(["a", "b"]));
    expect(screen.getByTestId("row-b").className).not.toMatch(/arrive/);
    rerender(rail(["a", "b", "c"]));
    expect(screen.getByTestId("row-c").className).toMatch(/arrive/);
  });

  it("a row that leaves closes where it stood, out of reach", () => {
    const { rerender } = render(rail(["a", "b"]));
    rerender(rail(["a"]));
    const leaving = screen.getByTestId("row-b");
    expect(leaving.className).toMatch(/leaving/);
    expect(leaving).toHaveAttribute("aria-hidden", "true");
    expect(leaving).toBeDisabled();
  });
});
