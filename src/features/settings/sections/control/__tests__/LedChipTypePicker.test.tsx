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
