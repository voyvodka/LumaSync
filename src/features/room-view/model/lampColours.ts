// The colour each Hue light glows in the 3D room until live colour reaches it, by its place in the
// map's channel list. The dock's chips read the same table, so a chip shows its lamp's colour.
// A warm white, as a lamp is at home: one rainbow colour per lamp read as a party, not a room.
export const LAMP_COLOURS = [0xffe0bf] as const;

export function lampColour(listIndex: number): number {
  return LAMP_COLOURS[listIndex % LAMP_COLOURS.length] ?? LAMP_COLOURS[0];
}

export function lampColourCss(listIndex: number): string {
  return `#${lampColour(listIndex).toString(16).padStart(6, "0")}`;
}
