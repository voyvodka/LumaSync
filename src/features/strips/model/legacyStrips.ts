import type { ShellState } from "@/shared/contracts/shell";
import {
  FIRST_STRIP_ID,
  type LedStrip,
  type StripHardware,
  type StripTransport,
} from "@/shared/contracts/strips";

/** The keys a strip is built from until the saved state holds strips of its own. */
export type LegacyStripSource = Pick<
  ShellState,
  | "lastSuccessfulPort"
  | "lastWledSink"
  | "ledCalibration"
  | "firmwareProfile"
  | "selectedChipType"
  | "ledColorOrder"
  | "colorCorrection"
  | "roomMap"
>;

const SECOND_STRIP_ID = "strip-2";

function hardwareOf(state: LegacyStripSource): StripHardware {
  const hardware: StripHardware = {};
  if (state.firmwareProfile != null)
    hardware.firmwareProfile = state.firmwareProfile;
  if (state.selectedChipType != null)
    hardware.chipType = state.selectedChipType;
  if (state.ledColorOrder != null) hardware.colorOrder = state.ledColorOrder;
  return hardware;
}

type PlacementRow = Record<string, unknown>;

// The file may have been edited by hand: rows that are not objects are skipped, as Rust skips them.
function placementsOf(state: LegacyStripSource): PlacementRow[] {
  const rows: unknown = state.roomMap?.usbStrips;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is PlacementRow =>
      typeof row === "object" && row !== null && !Array.isArray(row),
  );
}

function stripIdOf(placement: PlacementRow | undefined): string | undefined {
  const id = placement?.stripId;
  return typeof id === "string" ? id : undefined;
}

/**
 * The saved setup read as strips. One strip when anything describes one; none otherwise — a
 * Hue-only install has no strip, whatever its colour correction says. A file holding both a port
 * and a WLED device (hand-edited: the app never writes both) gets the WLED device as a second,
 * disabled strip, since the port has always won. Mirrored by `strips_from_legacy` in Rust; the
 * parity fixture holds the two together.
 */
export function stripsFromLegacy(state: LegacyStripSource): LedStrip[] {
  // `null` reads as absent, as Rust's reads do; so does a port that is not a string.
  const serial =
    typeof state.lastSuccessfulPort === "string"
      ? state.lastSuccessfulPort
      : undefined;
  const wled = state.lastWledSink ?? undefined;
  const layout = state.ledCalibration ?? undefined;
  const colorCorrection = state.colorCorrection ?? undefined;
  const hardware = hardwareOf(state);
  const describesStrip =
    serial !== undefined ||
    wled !== undefined ||
    layout !== undefined ||
    Object.keys(hardware).length > 0;
  if (!describesStrip) return [];

  const placements = placementsOf(state);
  const id =
    (serial !== undefined
      ? stripIdOf(placements.find((placement) => placement.portName === serial))
      : undefined) ??
    stripIdOf(placements[0]) ??
    FIRST_STRIP_ID;
  const transport: StripTransport | null =
    serial !== undefined
      ? { kind: "serial", portName: serial }
      : wled !== undefined
        ? { kind: "wled", sink: wled }
        : null;

  const shared = {
    ...(layout !== undefined ? { layout } : {}),
    ...(colorCorrection !== undefined ? { colorCorrection } : {}),
  };
  const strips: LedStrip[] = [
    { id, enabled: true, transport, hardware, ...shared },
  ];
  if (serial !== undefined && wled !== undefined) {
    strips.push({
      id: id === SECOND_STRIP_ID ? FIRST_STRIP_ID : SECOND_STRIP_ID,
      enabled: false,
      transport: { kind: "wled", sink: wled },
      hardware: {},
      ...shared,
    });
  }
  return strips;
}
