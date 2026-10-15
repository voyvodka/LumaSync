/** One material palette for the whole room: an evening interior — slate and caramel upholstery
 *  and warm woods, so the lights carry the colour, not the furniture. The floor and walls are the
 *  room's own choice (`model/surfaceColours.ts`). */
export const PALETTE = {
  floorGap: 0x4a3426,
  skirting: 0xd8d0c4,

  slate: 0x55657d,
  slateDeep: 0x46536a,
  slateCushion: 0x66778f,
  caramel: 0xb57f4b,
  caramelDeep: 0x9a6a3c,
  caramelCushion: 0xc28d58,
  sage: 0x7d8b78,
  pillowCamel: 0xcf9f6c,
  pillowCream: 0xe4dacb,

  oak: 0xb88d63,
  oakDark: 0x93694a,
  walnut: 0x6b4a33,
  lacquer: 0xddd5c9,
  handle: 0x3a3a3c,

  metal: 0x2b2d31,
  metalSoft: 0x5c6168,
  bezel: 0x121315,
  panel: 0x18223a,

  bookRed: 0xb4513e,
  bookBlue: 0x3f679a,
  paper: 0xefe9de,
  mug: 0xf2eee7,
  keyboard: 0x2e3035,
} as const;
