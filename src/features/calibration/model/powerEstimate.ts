import { LED_CHIP_TYPE, type LedChipType } from "@/shared/contracts/device";

/** Every strip this app drives runs on 5 V. */
export const STRIP_SUPPLY_VOLTS = 5;

/**
 * Datasheet worst case per pixel with every channel at full: a WS2812B draws
 * ~60 mA (0.3 W), an SK6812 RGBW ~80 mA (0.4 W) with the white die lit too.
 * The worst case, not a typical figure, because this number sizes the supply.
 */
const WATTS_PER_LED: Record<LedChipType, number> = {
  [LED_CHIP_TYPE.WS2812B_GRB]: 0.3,
  [LED_CHIP_TYPE.SK6812_RGBW]: 0.4,
};

export interface StripPowerEstimate {
  /** Whole watts. */
  watts: number;
  /** Amps at {@link STRIP_SUPPLY_VOLTS}, one decimal. */
  amps: number;
}

/** Maximum draw of the strip at full white, for sizing the power supply. */
export function estimateStripPower(
  totalLeds: number,
  chipType: LedChipType = LED_CHIP_TYPE.WS2812B_GRB,
): StripPowerEstimate {
  const leds = Number.isFinite(totalLeds) && totalLeds > 0 ? totalLeds : 0;
  const rawWatts = leds * WATTS_PER_LED[chipType];
  return {
    watts: Math.round(rawWatts),
    amps: Math.round((rawWatts / STRIP_SUPPLY_VOLTS) * 10) / 10,
  };
}
