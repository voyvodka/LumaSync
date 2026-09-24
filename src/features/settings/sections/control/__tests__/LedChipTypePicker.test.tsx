/**
 * The chip-type picker marks the selected tile when the connected firmware
 * reported the other pixel layout, and never changes the selection itself.
 * Driven through the real firmware bus, the way a connect reaches it.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FIRMWARE_PIXEL_LAYOUT,
  FIRMWARE_PROFILE,
  LED_CHIP_TYPE,
  type FirmwarePixelLayout,
} from "@/shared/contracts/device";
import { firmwareProfileEvents } from "@/features/device/firmwareProfileEvents";
import { readStylesheet } from "@/test/stylesheetSource";
import { LedChipTypePicker } from "../LedChipTypePicker";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mockSave = vi.fn(async (_partial: Record<string, unknown>) => undefined);

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: vi.fn(async () => ({})),
    save: (partial: Record<string, unknown>) => mockSave(partial),
  },
}));

function advertise(layout: FirmwarePixelLayout | undefined) {
  act(() => {
    firmwareProfileEvents.emit({
      advertisedFirmwareProfile: layout === undefined ? undefined : FIRMWARE_PROFILE.LUMASYNC_V1,
      advertisedPixelLayout: layout,
    });
  });
}

function tile(chipType: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-chip-type="${chipType}"]`);
  if (!found) throw new Error(`no tile for ${chipType}`);
  return found;
}

beforeEach(() => {
  mockSave.mockClear();
});

afterEach(() => {
  advertise(undefined);
});

// The tiles were styled inline with `all: unset`, which took the keyboard
// focus ring with it. happy-dom applies no stylesheet, so the rules are read.
describe("LedChipTypePicker — tile styling", () => {
  it("styles the tiles through the shared class, not inline", () => {
    render(<LedChipTypePicker initialChipType={LED_CHIP_TYPE.WS2812B_GRB} />);
    for (const chipType of [LED_CHIP_TYPE.WS2812B_GRB, LED_CHIP_TYPE.SK6812_RGBW]) {
      expect(tile(chipType)).toHaveClass("lm-strip-tile");
      expect(tile(chipType).getAttribute("style")).toBeNull();
    }
  });

  // A group named by the heading wrapped a radiogroup with the same name, so
  // every screen reader said "LED chip type" twice.
  it("names the choice once, on the radiogroup", () => {
    render(<LedChipTypePicker initialChipType={LED_CHIP_TYPE.WS2812B_GRB} />);
    expect(screen.getByRole("radiogroup", { name: "lights:led.chipType.label" })).toHaveAccessibleDescription(
      "lights:led.chipType.description",
    );
    expect(screen.queryByRole("group", { name: "lights:led.chipType.label" })).toBeNull();
  });

  it("gives the tile a focus ring, a checked state and a forced-colors rule", () => {
    const css = readStylesheet();
    expect(css).toMatch(/\.lm-strip-tile:focus-visible\s*\{[^}]*var\(--lm-focus-ring\)/);
    expect(css).toMatch(/\.lm-strip-tile\[aria-checked="true"\]\s*\{/);
    expect(css).toMatch(/@media \(forced-colors: active\)\s*\{\s*\.lm-strip-tile\s*\{/);
  });

  it("warns about SK6812 only under the Adalight profile", () => {
    const { rerender } = render(
      <LedChipTypePicker initialChipType={LED_CHIP_TYPE.SK6812_RGBW} firmwareProfile={FIRMWARE_PROFILE.ADALIGHT} />,
    );
    expect(screen.getByText("lights:led.chipType.sk6812AdalightWarning")).toBeInTheDocument();

    rerender(
      <LedChipTypePicker initialChipType={LED_CHIP_TYPE.SK6812_RGBW} firmwareProfile={FIRMWARE_PROFILE.LUMASYNC_V1} />,
    );
    expect(screen.queryByText("lights:led.chipType.sk6812AdalightWarning")).toBeNull();
  });
});

describe("LedChipTypePicker — firmware layout marker", () => {
  it("marks a WS2812B selection when the firmware reports RGBW", () => {
    render(<LedChipTypePicker initialChipType={LED_CHIP_TYPE.WS2812B_GRB} />);
    expect(tile(LED_CHIP_TYPE.WS2812B_GRB).dataset.mismatched).toBeUndefined();

    advertise(FIRMWARE_PIXEL_LAYOUT.RGBW);

    const selected = tile(LED_CHIP_TYPE.WS2812B_GRB);
    expect(selected.dataset.mismatched).toBe("true");
    expect(selected.textContent).toContain("lights:led.chipType.firmwareExpectsRgbw");
    expect(tile(LED_CHIP_TYPE.SK6812_RGBW).dataset.mismatched).toBeUndefined();
    expect(selected.getAttribute("aria-checked")).toBe("true");
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("marks an SK6812 selection when the firmware reports RGB", () => {
    render(<LedChipTypePicker initialChipType={LED_CHIP_TYPE.SK6812_RGBW} />);

    advertise(FIRMWARE_PIXEL_LAYOUT.RGB);

    const selected = tile(LED_CHIP_TYPE.SK6812_RGBW);
    expect(selected.dataset.mismatched).toBe("true");
    expect(selected.textContent).toContain("lights:led.chipType.firmwareExpectsRgb");
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("shows nothing when the layouts agree or the firmware is unknown", () => {
    render(<LedChipTypePicker initialChipType={LED_CHIP_TYPE.SK6812_RGBW} />);

    advertise(FIRMWARE_PIXEL_LAYOUT.RGBW);
    expect(tile(LED_CHIP_TYPE.SK6812_RGBW).dataset.mismatched).toBeUndefined();

    advertise(undefined);
    expect(tile(LED_CHIP_TYPE.SK6812_RGBW).dataset.mismatched).toBeUndefined();
    expect(screen.queryByText(/firmwareExpects/)).toBeNull();
  });
});
