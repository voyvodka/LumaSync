import { fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP, type HueZone, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { ObjectsPopover } from "../ObjectsPopover";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
}));

const zone: HueZone = {
  id: "z1",
  name: "Couch",
  entertainmentAreaId: "a",
  centerX: 0,
  centerY: 0,
  centerZ: 0,
  scaleX: 0.5,
  scaleY: 0.5,
  scaleZ: 0.5,
  channelIndices: [1],
  borderColor: "var(--lm-zone-2)",
};

const config: RoomMapConfig = {
  ...DEFAULT_ROOM_MAP,
  tvAnchor: { x: 1, y: 0.2, width: 1, height: 0.1 },
  furniture: [{ id: "sofa", type: "sofa", x: 1, y: 2, width: 2, height: 0.9, label: "Couch", locked: true }],
  hueChannels: [
    { channelIndex: 0, channelId: 0, x: 0, y: 0, z: 0, label: "Floor lamp" },
    { channelIndex: 1, channelId: 1, x: 0, y: 0, z: 0, label: "Shelf", zoneId: "z1" },
  ],
};

function Harness(props: { selectedId?: string | null; activeHueZoneId?: string | null; empty?: boolean }) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={anchorRef} type="button">
        anchor
      </button>
      <ObjectsPopover
        open
        onClose={vi.fn<() => void>()}
        anchorRef={anchorRef}
        id="objects"
        config={props.empty ? DEFAULT_ROOM_MAP : config}
        zones={props.empty ? [] : [zone]}
        selectedId={props.selectedId ?? null}
        activeHueZoneId={props.activeHueZoneId ?? null}
        onSelect={select}
        onSelectZone={selectZone}
      />
    </>
  );
}

const select = vi.fn<(objectId: string) => void>();
const selectZone = vi.fn<(zoneId: string) => void>();

const list = () => within(screen.getByRole("dialog", { name: "roomMap:dock.objects" }));

describe("ObjectsPopover", () => {
  it("lists the room's objects, then the Hue lights under their zones and the rest apart", () => {
    render(<Harness />);
    const names = list()
      .getAllByRole("button")
      .map((row) => row.getAttribute("aria-label") ?? row.textContent);
    expect(names).toEqual([
      "roomMap:objectPanel.tvLabel",
      "Couch",
      'Couch, roomMap:inspector.zoneChannelCount {"count":1}',
      "Shelf",
      "Floor lamp",
    ]);
    expect(list().getByRole("heading", { name: "roomMap:objects.hueLights" })).toBeInTheDocument();
  });

  it("selects a row's object, or a zone from its header", () => {
    render(<Harness />);
    fireEvent.click(list().getByRole("button", { name: "Couch" }));
    expect(select).toHaveBeenLastCalledWith("furniture-sofa", expect.anything());
    fireEvent.click(list().getByRole("button", { name: /^Couch, / }));
    expect(selectZone).toHaveBeenLastCalledWith("z1", expect.anything());
  });

  it("marks what is selected, and opens on it so the arrows start there", () => {
    render(<Harness selectedId="hue-1" />);
    const shelf = list().getByRole("button", { name: "Shelf" });
    expect(shelf).toHaveAttribute("aria-current", "true");
    expect(shelf).toHaveFocus();
    fireEvent.keyDown(shelf, { key: "ArrowDown" });
    expect(list().getByRole("button", { name: "Floor lamp" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(list().getByRole("button", { name: "roomMap:objectPanel.tvLabel" })).toHaveFocus();
  });

  it("says when the room is empty", () => {
    render(<Harness empty />);
    expect(list().getByText("roomMap:objectPanel.empty")).toBeInTheDocument();
  });
});
