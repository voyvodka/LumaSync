import { describe, expect, it } from "vitest";

import { HUE_REGION_PRESET_POSITIONS, type HueRegionPreset } from "../regionPresets";

const PRESETS: HueRegionPreset[] = ["left", "right", "top", "bottom", "center"];

/** Mirror of `channel_position_to_screen_region` in
 *  `src-tauri/src/commands/hue/frame.rs`. Rust labels the row's dot colour from
 *  the same position, so a preset that drifted out of its band would light one
 *  pill and paint another region's colour. */
function classifyLikeRust(x: number, y: number): string {
  if (Math.abs(x) >= Math.abs(y)) {
    if (x < -0.3) return "left";
    if (x > 0.3) return "right";
    return "center";
  }
  if (y > 0.3) return "top";
  if (y < -0.3) return "bottom";
  return "center";
}

describe("preset positions", () => {
  it("each preset lands in the band Rust would name it", () => {
    for (const preset of PRESETS) {
      const { x, y } = HUE_REGION_PRESET_POSITIONS[preset];
      expect(classifyLikeRust(x, y)).toBe(preset);
    }
  });

  it("puts the near preset at the TV wall and the far one behind the viewer", () => {
    // `+y` is depth, `+1` being the TV wall — the reason these read Near / Far.
    expect(HUE_REGION_PRESET_POSITIONS.top.y).toBe(1);
    expect(HUE_REGION_PRESET_POSITIONS.bottom.y).toBe(-1);
  });
});
