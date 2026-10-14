import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RoomMapConfig } from "@/shared/contracts/roomMap";

import { TemplateSelector } from "../TemplateSelector";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("TemplateSelector", () => {
  it("shows each template as its room drawn from above, and hands over the one picked", () => {
    const onSelect = vi.fn<(config: RoomMapConfig) => void>();
    render(<TemplateSelector onSelect={onSelect} />);

    const cards = screen.getAllByRole("button");
    expect(cards).toHaveLength(4);
    for (const card of cards) expect(card.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText(/📺|🖥|🏠|✏️/u)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "roomMap:templates.fullroom.name" }));
    const picked = onSelect.mock.calls[0]?.[0];
    expect(picked?.furniture.map((f) => f.type)).toEqual(["rug", "sofa", "table", "chair", "plant"]);
    expect(picked?.tvAnchor).toBeDefined();
  });
});
