import type { LedStrip, StripHardware, StripTransport } from "@/shared/contracts/strips";

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function transportOf(value: unknown): StripTransport | null {
  if (!isRow(value)) return null;
  if (value.kind === "serial") return typeof value.portName === "string" ? (value as StripTransport) : null;
  if (value.kind === "wled") return isRow(value.sink) ? (value as StripTransport) : null;
  // A kind a later build added: kept for its next write; no reader here matches it, as none in Rust does.
  return typeof value.kind === "string" ? (value as unknown as StripTransport) : null;
}

function hardwareOf(value: unknown): StripHardware {
  if (!isRow(value)) return {};
  const hardware: Row = { ...value };
  for (const key of Object.keys(hardware)) {
    if (hardware[key] === null) delete hardware[key];
  }
  return hardware as StripHardware;
}

/**
 * `ShellState.ledStrips` as read from disk, where it may have been edited by hand. A row that is
 * not an object or has no string `id` is skipped; other fields fall back one by one. A valid value
 * is kept as the object it was — fields a later build added survive this build's next write.
 * Mirrored by `strips_from_stored` in Rust; `storedStrips.parity.json` holds the two together.
 */
export function readStoredStrips(value: unknown): LedStrip[] {
  if (!Array.isArray(value)) return [];
  const strips: LedStrip[] = [];
  for (const row of value) {
    if (!isRow(row) || typeof row.id !== "string") continue;
    const { layout, colorCorrection, name, ...rest } = row;
    const strip = {
      ...rest,
      id: row.id,
      // Kept as written: only a blank or non-string value reads as no name.
      ...(typeof name === "string" && name.trim() !== "" ? { name } : {}),
      enabled: typeof row.enabled === "boolean" ? row.enabled : true,
      transport: transportOf(row.transport),
      hardware: hardwareOf(row.hardware),
      ...(layout != null ? { layout } : {}),
      ...(colorCorrection != null ? { colorCorrection } : {}),
    };
    strips.push(strip as LedStrip);
  }
  return strips;
}
