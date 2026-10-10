import { TWIN_FRAME } from "@/shared/contracts/preview";

export type Rgb = readonly [number, number, number];

export interface TwinFrame {
  seq: number;
  layoutRevision: number;
  leds: Rgb[];
  lamps: Rgb[];
}

/** One frame off the twin's channel, or `null` when its length disagrees
 *  with its own header — a short read is dropped, never drawn half. */
export function decodeTwinFrame(buffer: ArrayBuffer): TwinFrame | null {
  if (buffer.byteLength < TWIN_FRAME.HEADER_BYTES) return null;
  const view = new DataView(buffer);
  const ledCount = view.getUint32(TWIN_FRAME.LED_COUNT_OFFSET, true);
  const lampCount = view.getUint32(TWIN_FRAME.LAMP_COUNT_OFFSET, true);
  if (buffer.byteLength !== TWIN_FRAME.HEADER_BYTES + (ledCount + lampCount) * 3) return null;
  const bytes = new Uint8Array(buffer, TWIN_FRAME.HEADER_BYTES);
  const rgbAt = (i: number): Rgb => [bytes[i * 3] ?? 0, bytes[i * 3 + 1] ?? 0, bytes[i * 3 + 2] ?? 0];
  return {
    seq: view.getUint32(TWIN_FRAME.SEQ_OFFSET, true),
    layoutRevision: view.getUint32(TWIN_FRAME.REVISION_OFFSET, true),
    leds: Array.from({ length: ledCount }, (_, i) => rgbAt(i)),
    lamps: Array.from({ length: lampCount }, (_, i) => rgbAt(ledCount + i)),
  };
}
