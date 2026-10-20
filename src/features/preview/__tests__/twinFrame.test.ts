import { describe, expect, it } from "vitest";

import { decodeTwinFrame } from "../twinFrame";
import golden from "./twinFrame.golden.json";

function bufferOf(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes.buffer;
}

describe("decodeTwinFrame", () => {
  // Rust's encoder reads the same file; a field moved on either side fails one of them.
  it("reads the shared golden frame field for field", () => {
    expect(decodeTwinFrame(bufferOf(golden.hex))).toEqual({
      seq: golden.seq,
      layoutRevision: golden.layoutRevision,
      leds: golden.leds,
      lamps: golden.lamps,
    });
  });

  it("drops a frame whose length disagrees with its header", () => {
    expect(decodeTwinFrame(bufferOf(golden.hex.slice(0, -2)))).toBeNull();
    expect(decodeTwinFrame(new ArrayBuffer(8))).toBeNull();
  });
});
