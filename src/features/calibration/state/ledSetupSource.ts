import { shellStore } from "@/features/persistence/shellStore";
import type { LedChipType } from "@/shared/contracts/device";
import type { DisplayInfo } from "@/shared/contracts/display";
import type { LedStrip } from "@/shared/contracts/strips";
import { listDisplays } from "../calibrationApi";
import { primaryStrip, stripsOf } from "@/features/strips/model/stripSelectors";

/** What LED Setup reads before it can draw anything true: the displays, the saved one, and the strips. */
export interface LedSetupSource {
  displays: DisplayInfo[];
  selectedDisplayId: string | null;
  strips: readonly LedStrip[];
}

/** What LED Setup needs of the strip it edits: its chip, and the LED count a WLED device reported. */
export interface EditedStripFacts {
  chipType: LedChipType | null;
  /** The WLED sink's `ledCount`, unchecked. */
  wledLedCount: number | undefined;
}

/**
 * Of strip `stripId`, or with none named of the strip a layout with no strip named applies to: the
 * primary strip's chip and the first WLED device's count, as before strips were edited one by one.
 */
export function editedStripFacts(source: LedSetupSource, stripId?: string): EditedStripFacts {
  const wledCount = (strip: LedStrip | undefined) =>
    strip?.transport?.kind === "wled" ? strip.transport.sink.ledCount : undefined;
  if (stripId === undefined) {
    return {
      chipType: primaryStrip(source.strips)?.hardware.chipType ?? null,
      wledLedCount: wledCount(source.strips.find((strip) => strip.transport?.kind === "wled")),
    };
  }
  const strip = source.strips.find((candidate) => candidate.id === stripId);
  return { chipType: strip?.hardware.chipType ?? null, wledLedCount: wledCount(strip) };
}

let last: LedSetupSource | null = null;
let reading: Promise<LedSetupSource> | null = null;

/**
 * The last answer this session, so a return to LED Setup opens on it at once instead of on an empty
 * display list that fills in: "no displays", a 16:9 monitor reshaping to the real one, Test turning
 * on. Each visit still reads again, and a real change (a display plugged in) then applies.
 */
export function peekLedSetupSource(): LedSetupSource | null {
  return last;
}

export function readLedSetupSource(): Promise<LedSetupSource> {
  reading ??= Promise.all([listDisplays(), shellStore.load()])
    .then(([displays, shell]) => {
      last = {
        displays,
        selectedDisplayId: shell.selectedDisplayId ?? null,
        strips: stripsOf(shell),
      };
      return last;
    })
    .finally(() => {
      reading = null;
    });
  return reading;
}

/** Test-only: forget an earlier case's answer. */
export function __resetLedSetupSourceForTests(): void {
  last = null;
  reading = null;
}
