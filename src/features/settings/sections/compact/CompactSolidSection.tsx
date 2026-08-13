import { useCallback, useEffect, useRef } from "react";

import { HeroColorCard } from "./HeroColorCard";
import { SelfContainedBrightnessRow } from "./SelfContainedBrightnessRow";

/** Solid mode card. The draft lives here rather than in `CompactLayout` on
 *  purpose — hoisted, every brightness tick reconciled the mode strip and
 *  scene row too. */

interface CompactSolidSectionProps {
  incoming: { r: number; g: number; b: number; brightness: number };
  disabled: boolean;
  /** v1.5 W2 fix #41 — Adalight firmware lock parity with full Lights view. */
  brightnessDisabled?: boolean;
  /** Tooltip / mono notice surfaced when `brightnessDisabled` is true. */
  brightnessDisabledReason?: string;
  label: string;
  sublabel: string;
  onCommit: (payload: { r: number; g: number; b: number; brightness: number }) => void;
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

  const handleBrightnessCommit = useCallback(
    (nextUnit: number) => {
      const current = incomingRef.current;
      onCommit({ r: current.r, g: current.g, b: current.b, brightness: nextUnit });
    },
    [onCommit],
  );

  const handleColorChange = useCallback(
    (hex: string) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const current = incomingRef.current;
      onCommit({ r, g, b, brightness: current.brightness });
    },
    [onCommit],
  );

  const brightnessPct = Math.round(incoming.brightness * 100);

  return (
    <div className="lm-compact-card">
      <div className="lm-compact-card-header">
        <div className="l">{label}</div>
      </div>
      <HeroColorCard
        rgb={incoming}
        disabled={disabled}
        sublabel={sublabel}
        onChange={handleColorChange}
      />
      <SelfContainedBrightnessRow
        initialPercent={brightnessPct}
        disabled={disabled || brightnessDisabled}
        brightnessDisabledReason={brightnessDisabled ? brightnessDisabledReason : undefined}
        onCommit={handleBrightnessCommit}
      />
    </div>
  );
}
