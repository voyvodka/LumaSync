import type { ColorCorrectionConfig, WledUdpSinkConfig } from "@/shared/contracts/device";
import type { LedCalibrationConfig } from "@/shared/contracts/calibration";
import type { ShellState } from "@/shared/contracts/shell";
import { FIRST_STRIP_ID, type LedStrip, type StripHardware, type StripTransport } from "@/shared/contracts/strips";

import { placementsOf, stripIdOf } from "./legacyStrips";
import { stripsOf } from "./stripSelectors";

// Each helper maps the stored state to the partial a `shellStore.update` writes, so a strips edit
// is a revision-guarded read-modify-write. Strips keep every field they were read with.

type StripsPatch = Pick<ShellState, "ledStrips">;

/** The strip a write with no strip named lands on: the first enabled one, else the first. Readers
 *  take only an enabled one, so a hand-edited list with none enabled is written but not driven. */
function targetIndex(strips: readonly LedStrip[]): number {
  const enabled = strips.findIndex((strip) => strip.enabled);
  return enabled !== -1 ? enabled : strips.length > 0 ? 0 : -1;
}

/**
 * The strip a first write creates — what the legacy derivation gives for the same keys: the id of
 * the placement on its port, else the first placement's, and the global colour correction.
 */
function firstStrip(state: ShellState, portName?: string): LedStrip {
  const placements = placementsOf(state);
  const id =
    (portName !== undefined
      ? stripIdOf(placements.find((placement) => placement.portName === portName))
      : undefined) ??
    stripIdOf(placements[0]) ??
    FIRST_STRIP_ID;
  return {
    id,
    enabled: true,
    transport: null,
    hardware: {},
    ...(state.colorCorrection != null ? { colorCorrection: state.colorCorrection } : {}),
  };
}

function editTarget(
  state: ShellState,
  edit: (strip: LedStrip) => LedStrip,
  options: { portName?: string } = {},
): { strips: LedStrip[]; index: number } {
  const strips = [...stripsOf(state)];
  let index = targetIndex(strips);
  if (index === -1) {
    strips.push(firstStrip(state, options.portName));
    index = 0;
  }
  strips[index] = edit(strips[index]!);
  return { strips, index };
}

/** Sets the given hardware fields on the target strip; `undefined` clears one. */
export function withStripHardware(state: ShellState, patch: Partial<StripHardware>): StripsPatch {
  const { strips } = editTarget(state, (strip) => {
    const hardware: StripHardware = { ...strip.hardware };
    for (const [key, value] of Object.entries(patch) as [keyof StripHardware, unknown][]) {
      if (value === undefined) delete hardware[key];
      else (hardware as Record<string, unknown>)[key] = value;
    }
    return { ...strip, hardware };
  });
  return { ledStrips: strips };
}

export function withStripLayout(state: ShellState, layout: LedCalibrationConfig): StripsPatch {
  const { strips } = editTarget(state, (strip) => ({ ...strip, layout }));
  return { ledStrips: strips };
}

/**
 * One correction plan still drives the strip and Hue alike, so the global key is written; the
 * target strip gets the same copy. Never creates a strip: a Hue-only install has none.
 */
export function withColorCorrection(
  state: ShellState,
  colorCorrection: ColorCorrectionConfig,
): Pick<ShellState, "colorCorrection" | "ledStrips"> {
  const strips = [...stripsOf(state)];
  const index = targetIndex(strips);
  if (index === -1) return { colorCorrection };
  strips[index] = { ...strips[index]!, colorCorrection };
  return { colorCorrection, ledStrips: strips };
}

/**
 * The target strip is now driven through `transport`. One local sink is bound at a time, so any
 * other strip holding the other kind is dropped — its boot path would connect it beside this one — as saving
 * one key used to delete the other.
 */
function withTransport(state: ShellState, transport: StripTransport, portName?: string): StripsPatch {
  const { strips, index } = editTarget(state, (strip) => ({ ...strip, transport }), { portName });
  return {
    ledStrips: strips.filter(
      (strip, at) => at === index || strip.transport === null || strip.transport.kind === transport.kind,
    ),
  };
}

export function withSerialTransport(state: ShellState, portName: string): StripsPatch {
  return withTransport(state, { kind: "serial", portName }, portName);
}

export function withWledTransport(state: ShellState, sink: WledUdpSinkConfig): StripsPatch {
  return withTransport(state, { kind: "wled", sink });
}

/** The saved WLED device, refreshed in place (the device reported a new LED count). */
export function withWledSink(state: ShellState, sink: WledUdpSinkConfig): StripsPatch | null {
  const strips = [...stripsOf(state)];
  const index = strips.findIndex((strip) => strip.transport?.kind === "wled");
  if (index === -1) return null;
  const strip = strips[index]!;
  strips[index] = { ...strip, transport: { ...strip.transport!, kind: "wled", sink } };
  return { ledStrips: strips };
}

/**
 * The WLED device at `ip` dropped from the strips, as `forget_wled_in` does in Rust: the primary
 * strip keeps its layout and hardware with no transport, and goes once it describes nothing; any
 * other strip on that device goes.
 */
export function withoutWledDevice(state: ShellState, ip: string): StripsPatch | null {
  const strips = stripsOf(state);
  const primary = strips.findIndex((strip) => strip.enabled);
  const onDevice = (strip: LedStrip) =>
    strip.transport?.kind === "wled" && typeof strip.transport.sink.ip === "string" && strip.transport.sink.ip.trim() === ip.trim();
  if (!strips.some(onDevice)) return null;
  const next: LedStrip[] = [];
  strips.forEach((strip, at) => {
    if (!onDevice(strip)) return next.push(strip);
    if (at !== primary) return;
    const kept = { ...strip, transport: null };
    if (kept.layout !== undefined || Object.values(kept.hardware).some((value) => value != null)) next.push(kept);
  });
  return { ledStrips: next };
}

/** Longest name a strip keeps, in characters as the user sees them. */
export const STRIP_NAME_MAX = 40;

/**
 * The strip `stripId` renamed; a blank name clears it, back to the name of its device. `null` when
 * no strip has that id — a rename never lands on another strip or creates one.
 */
export function withStripName(state: ShellState, stripId: string, name: string): StripsPatch | null {
  const strips = [...stripsOf(state)];
  const index = strips.findIndex((strip) => strip.id === stripId);
  if (index === -1) return null;
  // By code point, so an emoji at the cut is not split in half.
  const trimmed = Array.from(name.trim()).slice(0, STRIP_NAME_MAX).join("").trim();
  const { name: _previous, ...rest } = strips[index]!;
  strips[index] = trimmed === "" ? rest : { ...rest, name: trimmed };
  return { ledStrips: strips };
}
