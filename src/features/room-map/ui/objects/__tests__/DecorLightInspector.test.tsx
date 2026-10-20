import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { HueChannelPlacement, LightStructure } from "@/shared/contracts/roomMap";

import { DecorLightInspector } from "../DecorLightInspector";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const pendant: LightStructure = { id: "dining", kind: "light", x: 1, y: 3, fixture: "pendant" };

function renderInspector(light: LightStructure = pendant, channels: HueChannelPlacement[] = [{ channelIndex: 2, x: 0, y: 0, z: 0 }]) {
  const handlers = {
    onMove: vi.fn<(x: number, y: number) => void>(),
    onHeightChange: vi.fn<(height: number | undefined) => void>(),
    onUpdate: vi.fn<(patch: { fixture: LightStructure["fixture"] }) => void>(),
    onDriveWithHue: vi.fn<(channelIndex: number) => void>(),
    onRename: vi.fn<(label: string) => void>(),
    onToggleLock: vi.fn<() => void>(),
    onClose: vi.fn<() => void>(),
  };
  render(<DecorLightInspector light={light} name="Pendant" roomWidthMeters={5} roomDepthMeters={4} roomHeightMeters={2.5} channels={channels} {...handlers} />);
  return handlers;
}

const drivePicker = () => screen.getByRole("button", { name: "roomMap:inspector.decorDriveAction" });

describe("DecorLightInspector", () => {
  it("hands the Hue light picked to drive the lamp", () => {
    vi.useFakeTimers();
    const { onDriveWithHue } = renderInspector();
    fireEvent.click(drivePicker());
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("option")[0]!);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onDriveWithHue).toHaveBeenCalledWith(2);
    vi.useRealTimers();
  });

  it("offers no locked Hue light, and says so when none is free", () => {
    renderInspector(pendant, [{ channelIndex: 2, x: 0, y: 0, z: 0, locked: true }]);
    expect(screen.queryByRole("button", { name: "roomMap:inspector.decorDriveAction" })).toBeNull();
    expect(screen.getByText("roomMap:inspector.decorDriveNone")).toBeInTheDocument();
  });

  it("offers to hang it back where its fixture hangs only once it has a drop of its own", () => {
    const { onHeightChange } = renderInspector({ ...pendant, dropMeters: 0.3 });
    fireEvent.click(screen.getByRole("button", { name: "roomMap:inspector.hueHang" }));
    expect(onHeightChange).toHaveBeenCalledWith(undefined);
  });

  it("offers no hang for a lamp hanging where its fixture hangs", () => {
    renderInspector();
    expect(screen.queryByRole("button", { name: "roomMap:inspector.hueHang" })).toBeNull();
  });
});
