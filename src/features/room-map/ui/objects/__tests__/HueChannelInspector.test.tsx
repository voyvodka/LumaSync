// The slider stays in Hue's [-1, 1] because that is what is persisted; only the
// readout is metres. `aria-valuetext` is the gain over the Devices strip.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { HueChannelInspector } from "../HueChannelInspector";
import type { HueChannelPlacement } from "@/shared/contracts/roomMap";

const FIXTURE_LOCALES: Record<string, string> = {
  "roomMap:inspector.hueHeightLabel": "Height",
  "roomMap:inspector.hueHeightAriaLabel": "Channel height, floor to ceiling",
  "roomMap:inspector.hueHeightFloor": "floor level",
  "roomMap:inspector.hueHeightEye": "eye level",
  "roomMap:inspector.hueHeightCeiling": "ceiling level",
  "roomMap:inspector.hueHeightValueText": "{{metres}} m — {{label}}",
  "roomMap:inspector.hueHeightReadout": "{{metres}} m",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = FIXTURE_LOCALES[key] ?? key;
      if (!opts) return template;
      return Object.entries(opts).reduce(
        (acc, [k, v]) => acc.split(`{{${k}}}`).join(String(v)),
        template,
      );
    },
  }),
}));

const channel: HueChannelPlacement = { channelIndex: 0, x: 0, y: 0, z: 0 };

function renderInspector(worldZ: number, onHeightChange = vi.fn(), locked = false) {
  render(
    <HueChannelInspector
      channel={locked ? { ...channel, locked: true } : channel}
      zoneName={null}
      worldZ={worldZ}
      roomHeightMeters={2.5}
      onHeightChange={onHeightChange}
      onRename={vi.fn()}
      onToggleLock={vi.fn()}
    />,
  );
  return onHeightChange;
}

describe("HueChannelInspector height control", () => {
  beforeEach(cleanup);

  it("announces the height in metres, not the stored -1..1 value", () => {
    renderInspector(0);
    const slider = screen.getByRole("slider");
    // Mid-range in a 2.5 m room is 1.25 m, and the raw value is 0.
    expect(slider.getAttribute("aria-valuetext")).toBe("1.25 m — eye level");
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
  });

  it("names the band the height falls in", () => {
    renderInspector(-1);
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("0.00 m — floor level");
    cleanup();
    renderInspector(1);
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("2.50 m — ceiling level");
  });

  it("reports the edited height in world coordinates, not metres", () => {
    const onHeightChange = renderInspector(0);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "0.6" } });
    expect(onHeightChange).toHaveBeenCalledWith(0.6);
  });

  it("is disabled on a locked channel, like the label field beside it", () => {
    renderInspector(0, vi.fn(), true);
    expect((screen.getByRole("slider") as HTMLInputElement).disabled).toBe(true);
  });
});
