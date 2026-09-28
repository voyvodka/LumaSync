import { useCallback, useEffect, useRef } from "react";

import { kelvinToRgb, parseHex } from "@/shared/lib/color";
import type { SolidColorPayload } from "@/shared/contracts/mode";

import { DEFAULT_WHITE_KELVIN, KelvinSlider, SolidToneTabs } from "../control/SolidWhite";
import { HeroColorCard } from "./HeroColorCard";
import { SelfContainedBrightnessRow } from "./SelfContainedBrightnessRow";

/** Solid mode card. The draft lives here rather than in `CompactLayout` on
 *  purpose — hoisted, every brightness tick reconciled the mode strip and
 *  scene row too. */

interface CompactSolidSectionProps {
  incoming: SolidColorPayload;
  disabled: boolean;
  /** Adalight firmware lock parity with full Lights view. */
  brightnessDisabled?: boolean;
  /** Tooltip / mono notice surfaced when `brightnessDisabled` is true. */
  brightnessDisabledReason?: string;
  label: string;
  sublabel: string;
  onCommit: (payload: SolidColorPayload) => void;
}

export function CompactSolidSection({
  incoming,
  disabled,
  brightnessDisabled = false,
  brightnessDisabledReason,
  label,
  sublabel,
  onCommit,
}: CompactSolidSectionProps) {
  const incomingRef = useRef(incoming);
  useEffect(() => {
    incomingRef.current = incoming;
  }, [incoming]);
  // White reopens at the temperature it last had.
  const lastKelvin = useRef(incoming.kelvin ?? DEFAULT_WHITE_KELVIN);
  if (incoming.kelvin != null) lastKelvin.current = incoming.kelvin;
  const white = incoming.kelvin != null;
  // Colour reopens on the colour it had; a solid first seen as White has only its white.
  const lastColor = useRef({ r: incoming.r, g: incoming.g, b: incoming.b });
  if (!white) lastColor.current = { r: incoming.r, g: incoming.g, b: incoming.b };

  const handleBrightnessCommit = useCallback(
    (nextUnit: number) => {
      onCommit({ ...incomingRef.current, brightness: nextUnit });
    },
    [onCommit],
  );

  const handleKelvin = useCallback(
    (kelvin: number) => {
      onCommit({ ...kelvinToRgb(kelvin), brightness: incomingRef.current.brightness, kelvin });
    },
    [onCommit],
  );

  const handleColorChange = useCallback(
    (hex: string) => {
      const rgb = parseHex(hex);
      if (!rgb) return;
      onCommit({ ...rgb, brightness: incomingRef.current.brightness });
    },
    [onCommit],
  );

  const brightnessPct = Math.round(incoming.brightness * 100);

  return (
    <div className="lm-compact-card">
      <div className="lm-compact-card-header">
        <div className="l">{label}</div>
        <SolidToneTabs
          tone={white ? "white" : "colour"}
          disabled={disabled}
          onChange={(tone) =>
            tone === "white"
              ? handleKelvin(lastKelvin.current)
              : onCommit({ ...lastColor.current, brightness: incoming.brightness })
          }
        />
      </div>
      {white ? (
        <div className="px-3 pb-2 pt-1">
          <KelvinSlider kelvin={incoming.kelvin ?? lastKelvin.current} disabled={disabled} onChange={handleKelvin} />
        </div>
      ) : (
        <HeroColorCard
          rgb={incoming}
          disabled={disabled}
          sublabel={sublabel}
          onChange={handleColorChange}
        />
      )}
      <SelfContainedBrightnessRow
        initialPercent={brightnessPct}
        disabled={disabled || brightnessDisabled}
        brightnessDisabledReason={brightnessDisabled ? brightnessDisabledReason : undefined}
        onCommit={handleBrightnessCommit}
      />
    </div>
  );
}
