import type { RoomMapScreenUnit } from "@/shared/contracts/shell";

export const SIZE_UNITS = {
  inch: { metres: 0.0254, min: 10, max: 150 },
  cm: { metres: 0.01, min: 25, max: 380 },
} as const satisfies Record<RoomMapScreenUnit, { metres: number; min: number; max: number }>;

export type SizeUnit = RoomMapScreenUnit;

/** `ratio` is height over width. */
export function screenDiagonal(width: number, ratio: number, unit: SizeUnit): number {
  return (width * Math.hypot(1, ratio)) / SIZE_UNITS[unit].metres;
}

export function widthForDiagonal(diagonal: number, ratio: number, unit: SizeUnit): number {
  return (diagonal * SIZE_UNITS[unit].metres) / Math.hypot(1, ratio);
}
