import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  FIRMWARE_PIXEL_LAYOUT,
  FIRMWARE_PROFILE,
  LED_CHIP_TYPE,
  type FirmwareProfile,
  type LedChipType,
} from "@/shared/contracts/device";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/features/persistence/shellStore", () => ({ shellStore: { update: async () => ({}) } }));

import { ChipRow, FirmwareRow } from "../StripHardwareRows";

const V1 = FIRMWARE_PROFILE.LUMASYNC_V1;
const ADALIGHT = FIRMWARE_PROFILE.ADALIGHT;

describe("FirmwareRow", () => {
  it("a pick with nothing reported is saved at once", () => {
    const onChange = vi.fn<(next: FirmwareProfile) => void>();
    render(<FirmwareRow profile={V1} advertised={undefined} dontAsk={false} onChange={onChange} />);
    fireEvent.click(screen.getByTestId(`strip-firmware-${ADALIGHT}`));
    expect(onChange).toHaveBeenCalledWith(ADALIGHT);
  });

  it("picking against what the controller reports asks first, beside the choice", () => {
    const onChange = vi.fn<(next: FirmwareProfile) => void>();
    render(<FirmwareRow profile={V1} advertised={V1} dontAsk={false} onChange={onChange} />);

    fireEvent.click(screen.getByTestId(`strip-firmware-${ADALIGHT}`));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("strip-firmware-confirm-yes"));
    expect(onChange).toHaveBeenCalledWith(ADALIGHT);
  });

  it("the saved don't-ask choice is honoured", () => {
    const onChange = vi.fn<(next: FirmwareProfile) => void>();
    render(<FirmwareRow profile={V1} advertised={V1} dontAsk onChange={onChange} />);
    fireEvent.click(screen.getByTestId(`strip-firmware-${ADALIGHT}`));
    expect(onChange).toHaveBeenCalledWith(ADALIGHT);
    expect(screen.queryByTestId("strip-firmware-confirm")).toBeNull();
  });

  it("says so only when the chosen profile disagrees with the controller", () => {
    const { rerender } = render(<FirmwareRow profile={V1} advertised={V1} dontAsk={false} onChange={() => {}} />);
    expect(screen.queryByTestId("strip-firmware-note")).toBeNull();
    rerender(<FirmwareRow profile={ADALIGHT} advertised={V1} dontAsk={false} onChange={() => {}} />);
    expect(screen.getByTestId("strip-firmware-note")).toHaveTextContent("device:strip.firmware.mismatch");
  });
});

describe("ChipRow", () => {
  const renderChip = (chip: LedChipType, profile: FirmwareProfile, layout?: (typeof FIRMWARE_PIXEL_LAYOUT)[keyof typeof FIRMWARE_PIXEL_LAYOUT]) =>
    render(<ChipRow chip={chip} profile={profile} advertisedLayout={layout} onChange={() => {}} />);

  it("warns about RGBW only under Adalight", () => {
    renderChip(LED_CHIP_TYPE.SK6812_RGBW, ADALIGHT);
    expect(screen.getByText("lights:led.chipType.sk6812AdalightWarning")).toBeInTheDocument();
  });

  it("marks a chip the firmware's pixel layout disagrees with", () => {
    renderChip(LED_CHIP_TYPE.WS2812B_GRB, V1, FIRMWARE_PIXEL_LAYOUT.RGBW);
    expect(screen.getByText("lights:led.chipType.firmwareExpectsRgbw")).toBeInTheDocument();
  });

  it("says nothing when they agree or the firmware is unknown", () => {
    renderChip(LED_CHIP_TYPE.WS2812B_GRB, V1, FIRMWARE_PIXEL_LAYOUT.RGB);
    expect(screen.queryByText(/lights:led.chipType/)).toBeNull();
  });
});
