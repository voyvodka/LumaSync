/** What the shell's notices and deep links name on the Devices page: a strip, or the Hue bridge.
 * The rail itself lists devices (`deviceRail.ts`); these land on the first strip or the bridge. */
export type DeviceCategory = "strips" | "hue";

/** A deep link into one category. The nonce makes asking twice for the same one count. */
export interface DeviceCategoryRequest {
  category: DeviceCategory;
  nonce: number;
}
