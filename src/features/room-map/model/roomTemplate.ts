import { type RoomMapConfig, resolveRoomFootprint, type UsbStripPlacement } from "@/shared/contracts/roomMap";

/**
 * Whether the room map opens on the template picker: nothing the user placed is
 * on the map. A strip linked to a port does not count — connecting a
 * controller on Devices → USB writes one, and that must not take the templates
 * away from a first-time USB user. Hue channels do not count either: the
 * bridge sync seeds them a moment after the map opens, so counting them took
 * the picker away under a first-time Hue user's pointer. A template keeps both.
 * A strip drawn without a port does count.
 */
export function isRoomMapEmpty(config: RoomMapConfig): boolean {
  return (
    // A room drawn into an L is a choice already made, even with nothing in it yet.
    resolveRoomFootprint(config).length === 4 &&
    !config.tvAnchor &&
    config.furniture.length === 0 &&
    !(Array.isArray(config.structures) && config.structures.length > 0) &&
    config.usbStrips.every((strip) => Boolean(strip.portName))
  );
}

/**
 * A template applied over the current map. The layout is the template's, but
 * what the user connected and what the bridge sync owns stay: every
 * port-linked strip is kept — the first one takes the template's strip
 * placement, keeping its id, port and LED count — and the Hue channels and
 * zones (other areas' included) are carried over untouched.
 */
export function applyRoomTemplate(current: RoomMapConfig, template: RoomMapConfig): RoomMapConfig {
  const [first, ...others] = current.usbStrips.filter((strip) => Boolean(strip.portName));
  const [placement, ...otherTemplateStrips] = template.usbStrips;

  let usbStrips: UsbStripPlacement[];
  if (!first) {
    usbStrips = template.usbStrips;
  } else if (!placement) {
    usbStrips = [first, ...others];
  } else {
    usbStrips = [
      {
        ...placement,
        stripId: first.stripId,
        portName: first.portName,
        ledCount: first.ledCount,
        // The density is the tape's, like its LED count; the template's run is still drawn as is.
        ...(first.ledsPerMeter !== undefined ? { ledsPerMeter: first.ledsPerMeter } : {}),
      },
      ...others,
      ...otherTemplateStrips,
    ];
  }

  // A template lays out the furniture and the room's build; the room's finish is the user's and stays.
  return { ...template, usbStrips, hueChannels: current.hueChannels, zones: current.zones, surfaces: current.surfaces };
}
