import { shellStore } from "@/features/persistence/shellStore";
import type { LedChipType } from "@/shared/contracts/device";
import type { DisplayInfo } from "@/shared/contracts/display";
import { listDisplays } from "../calibrationApi";

/** What LED Setup reads before it can draw anything true: the displays and three saved values. */
export interface LedSetupSource {
  displays: DisplayInfo[];
  selectedDisplayId: string | null;
  chipType: LedChipType | null;
  /** `lastWledSink.ledCount`, unchecked. */
  wledLedCount: number | undefined;
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
        chipType: shell.selectedChipType ?? null,
        wledLedCount: shell.lastWledSink?.ledCount,
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
