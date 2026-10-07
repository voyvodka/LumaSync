import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SolidColorPayload } from "@/shared/contracts/mode";
import { parseHex, rgbToHex } from "@/shared/lib/color";
import { useArrivals } from "@/shared/lib/useArrivals";
import { useFlip } from "@/shared/lib/useFlip";
import { HsvColorPicker } from "@/shared/ui/HsvColorPicker/HsvColorPicker";
import { Popover } from "@/shared/ui/Popover/Popover";
import { RangeRow } from "@/shared/ui/RangeRow/RangeRow";
import { Stage, StageChoice, StageGrid } from "@/shared/ui/Stage/Stage";
import { DEFAULT_WHITE_KELVIN, KelvinSlider, type SolidTone } from "./SolidWhite";
import { useSolidColorDraft, type SolidDraft } from "./useSolidColorDraft";
import styles from "./SolidStage.module.css";

interface SolidStageProps {
  solid: SolidColorPayload;
  /** The compact window: the colour opens in a popover from its swatch. */
  dense?: boolean;
  disabled?: boolean;
  brightnessLocked?: boolean;
  brightnessTitle?: string;
  onCommit: (solid: SolidDraft) => void;
}

/** Solid's stage: a colour or a white, and how bright it is. */
export function SolidStage({
  solid,
  dense = false,
  disabled = false,
  brightnessLocked = false,
  brightnessTitle,
  onCommit,
}: SolidStageProps) {
  const { t } = useTranslation();
  const { draft, setColor, setKelvin, setBrightness } = useSolidColorDraft({ incoming: solid, onCommit });
  const tone: SolidTone = draft.kelvin != null ? "white" : "colour";
  // White reopens at the temperature it last had, Colour on the colour it had; a solid first seen
  // as White has only its white.
  const lastKelvin = useRef(solid.kelvin ?? DEFAULT_WHITE_KELVIN);
  if (draft.kelvin != null) lastKelvin.current = draft.kelvin;
  const lastColor = useRef({ r: draft.r, g: draft.g, b: draft.b });
  if (tone === "colour") lastColor.current = { r: draft.r, g: draft.g, b: draft.b };

  // Colour and White differ in height: the stage follows to the new one, brightness slides to its
  // new place and the new control fades in, rather than the page jumping.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useFlip(bodyRef, [tone], { resize: true });
  const { arrived, settled } = useArrivals([tone]);

  const hex = rgbToHex(draft);
  const brightness = Math.round(draft.brightness * 100);
  const pickColour = (next: string) => {
    const rgb = parseHex(next);
    if (rgb) setColor(rgb);
  };

  return (
    <Stage dense={dense} testId="solid-stage">
      <StageChoice
        className={styles.tone}
        ariaLabel={t("lights:solid.tone")}
        value={tone}
        disabled={disabled}
        onChange={(next) => (next === "white" ? setKelvin(lastKelvin.current) : setColor(lastColor.current))}
        options={[
          { value: "colour", label: t("lights:solid.colour"), testId: "solid-tone-colour" },
          { value: "white", label: t("lights:solid.white"), testId: "solid-tone-white" },
        ]}
      />
      <div ref={bodyRef} className={styles.body}>
      <StageGrid lead={tone === "colour" && !dense}>
        <div
          key={tone}
          className={styles.toneBody}
          data-entering={arrived.has(tone) || undefined}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) settled(tone);
          }}
        >
          {tone === "white" ? (
            <KelvinSlider kelvin={draft.kelvin ?? lastKelvin.current} disabled={disabled} onChange={setKelvin} />
          ) : dense ? (
            <SwatchPicker hex={hex} disabled={disabled} onChange={pickColour} />
          ) : (
            <div className={styles.colour}>
              <HsvColorPicker value={hex} onChange={pickColour} disabled={disabled} ariaLabel={t("common:mode.solidColor")} />
            </div>
          )}
        </div>
        <div data-flip-id="brightness">
        <RangeRow
          variant="stage"
          label={t("common:mode.brightness")}
          valueLabel={(v) => `${Math.round(v)}%`}
          min={0}
          max={100}
          step={1}
          value={brightness}
          disabled={disabled || brightnessLocked}
          title={brightnessTitle}
          onChange={(v) => setBrightness(v / 100)}
          testId="solid-brightness"
        />
        </div>
      </StageGrid>
      </div>
    </Stage>
  );
}

/** Compact's colour: the swatch and its hex; the picker floats over the window from it. */
function SwatchPicker({ hex, disabled, onChange }: { hex: string; disabled: boolean; onChange: (hex: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={styles.swatch}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={t("common:mode.solidColor")}
        onClick={() => setOpen((v) => !v)}
        data-testid="solid-swatch"
      >
        <span className={styles.chip} style={{ background: hex }} />
        <span className={styles.hex}>{hex.toUpperCase()}</span>
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        side="below"
        width="fit"
        id={id}
        role="dialog"
        label={t("common:mode.solidColor")}
      >
        <div className={styles.popover}>
          <HsvColorPicker compact value={hex} onChange={onChange} ariaLabel={t("common:mode.solidColor")} />
        </div>
      </Popover>
    </>
  );
}
