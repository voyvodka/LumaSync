// `channelIndex` is the index inside the entertainment area, not the array
// slot; room maps written by v1.4.0 and earlier are gapped. See
// docs/architecture/room-map.md.
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";
import { hueChannelObjectId } from "../../model/objectId";
import { PropertyBar } from "../PropertyBar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

/** Array order deliberately disagrees with `channelIndex` on every entry. */
const GAPPED_CONFIG: RoomMapConfig = {
  ...DEFAULT_ROOM_MAP,
  hueChannels: [
    { channelIndex: 2, x: 0.25, y: 0.75, z: 0 },
    { channelIndex: 0, x: -0.5, y: -0.25, z: 0 },
  ],
};

function renderPropertyBar(config: RoomMapConfig, selectedId: string | null) {
  return render(
    <PropertyBar
      config={config}
      selectedId={selectedId}
      onUpdatePosition={vi.fn()}
      onUpdateSize={vi.fn()}
      onUpdateRotation={vi.fn()}
    />,
  );
}

function fieldValues(): string[] {
  return screen
    .getAllByRole("spinbutton")
    .map((input) => (input as HTMLInputElement).value);
}

describe("PropertyBar — Hue channel fields resolve by identity", () => {
  it("shows the coordinates of the channel with the matching channelIndex", () => {
    renderPropertyBar(GAPPED_CONFIG, hueChannelObjectId(0));

    expect(fieldValues()).toEqual(["-0.50", "-0.25"]);
  });

  it("shows the coordinates of a channel stored ahead of its own index", () => {
    renderPropertyBar(GAPPED_CONFIG, hueChannelObjectId(2));

    expect(fieldValues()).toEqual(["0.25", "0.75"]);
  });

  it("renders the empty bar for a channelIndex that is not in the config", () => {
    renderPropertyBar(GAPPED_CONFIG, hueChannelObjectId(1));

    expect(screen.queryAllByRole("spinbutton")).toHaveLength(0);
  });
});
