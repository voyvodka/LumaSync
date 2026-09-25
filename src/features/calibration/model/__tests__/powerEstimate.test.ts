// The header figure sizes a power supply, so it is the full-white worst case.
// It once read 0.06 W per LED — a fifth of what a WS2812B strip can pull.
import { describe, expect, it } from "vitest";

import { LED_CHIP_TYPE } from "@/shared/contracts/device";

import { estimateStripPower } from "../powerEstimate";

describe("estimateStripPower", () => {
  it("gives a WS2812B strip's full-white draw in watts and amps at 5 V", () => {
    expect(estimateStripPower(164)).toEqual({ watts: 49, amps: 9.8 });
  });

  it("allows for the white die on an SK6812 RGBW strip", () => {
    expect(estimateStripPower(164, LED_CHIP_TYPE.SK6812_RGBW)).toEqual({ watts: 66, amps: 13.1 });
  });

  it("reads zero for an empty or nonsense count", () => {
    expect(estimateStripPower(0)).toEqual({ watts: 0, amps: 0 });
    expect(estimateStripPower(Number.NaN)).toEqual({ watts: 0, amps: 0 });
  });
});
