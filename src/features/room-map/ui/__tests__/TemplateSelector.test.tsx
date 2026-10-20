import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FURNITURE_CATALOGUE, type FurnitureType, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { ROOM_TEMPLATES } from "../../model/roomTemplates";
import { TemplateSelector } from "../TemplateSelector";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("TemplateSelector", () => {
  it("shows each template as its room drawn from above, and hands over the one picked", () => {
    const onSelect = vi.fn<(config: RoomMapConfig) => void>();
    render(<TemplateSelector onSelect={onSelect} />);

    const cards = screen.getAllByRole("button");
    expect(cards).toHaveLength(ROOM_TEMPLATES.length);
    for (const card of cards) expect(card.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText(/📺|🖥|🏠|✏️/u)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "roomMap:templates.fullroom.name" }));
    const picked = onSelect.mock.calls[0]?.[0];
    expect(picked?.furniture.map((f) => f.type)).toEqual(["rug", "storage", "storage", "table", "sofa", "chair", "table", "plant", "plant"]);
    expect(picked?.tvAnchor).toBeDefined();
  });

  const pick = (name: string) => {
    const onSelect = vi.fn<(config: RoomMapConfig) => void>();
    render(<TemplateSelector onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name }));
    return onSelect.mock.calls[0]![0];
  };

  it("lays out every type in every model it takes in the showroom, each inside the room and clear of the rest", () => {
    cleanup();
    const room = pick("roomMap:templates.showroom.name");
    const shown = new Set(room.furniture.map((f) => `${f.type}:${f.variant ?? ""}`));
    for (const [type, { variants }] of Object.entries(FURNITURE_CATALOGUE) as Array<[FurnitureType, { variants: readonly string[] }]>) {
      if (variants.length === 0) expect(shown.has(`${type}:`), type).toBe(true);
      for (const variant of variants) expect(shown.has(`${type}:${variant}`), `${type}:${variant}`).toBe(true);
    }
    // The dining chair and the dining table shared an id, so picking one selected both.
    const ids = room.furniture.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    const { widthMeters, depthMeters } = room.dimensions;
    const standing = room.furniture.filter((f) => f.type !== "rug");
    for (const f of room.furniture) {
      expect(f.x >= 0 && f.y >= 0 && f.x + f.width <= widthMeters && f.y + f.height <= depthMeters, f.id).toBe(true);
    }
    for (const a of standing) {
      for (const b of standing) {
        if (a === b) continue;
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
  });

  it("turns every showroom piece backed onto a wall to face the room", () => {
    cleanup();
    const room = pick("roomMap:templates.showroom.name");
    const { depthMeters } = room.dimensions;
    for (const f of room.furniture) {
      if (f.y <= 0.05) expect(f.rotation, f.id).toBe(180);
      if (f.y + f.height >= depthMeters - 0.05) expect(f.rotation ?? 0, f.id).toBe(0);
    }
  });
});
