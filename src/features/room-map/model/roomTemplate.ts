import type { RoomMapConfig, UsbStripPlacement } from "@/shared/contracts/roomMap";

/**
 * Whether the editor opens on the template picker: nothing the user placed is
 * on the map. A strip linked to a port does not count — connecting a
 * controller on Devices → USB writes one, and that must not take the templates
 * away from a first-time USB user. A strip drawn without a port does count.
 */
export function isRoomMapEmpty(config: RoomMapConfig, visibleHueChannelCount: number): boolean {
  return (
    !config.tvAnchor &&
    config.furniture.length === 0 &&
    config.usbStrips.every((strip) => Boolean(strip.portName)) &&
    visibleHueChannelCount === 0
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
      { ...placement, stripId: first.stripId, portName: first.portName, ledCount: first.ledCount },
      ...others,
      ...otherTemplateStrips,
    ];
  }

  return { ...template, usbStrips, hueChannels: current.hueChannels, zones: current.zones };
}
