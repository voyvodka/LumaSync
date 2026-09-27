import type { TFunction } from "i18next";

import type { TranslationKey } from "@/features/i18n/catalogue";
import type { RailItem } from "@/shared/ui/Rail/Rail";
import { bridgeDisplayName } from "@/features/hue/model/bridgeIdentity";
import { shortPortName, type DeviceRailEntry } from "../model/deviceRail";

type Kind = DeviceRailEntry["kind"];
type EntryOf<K extends Kind> = Extract<DeviceRailEntry, { kind: K }>;

interface RailRowSpec<K extends Kind> {
  label: (entry: EntryOf<K>, t: TFunction) => string;
  /** The heading the row sits under. */
  group: TranslationKey;
  /** Something there to add rather than something already here. */
  ghost: (entry: EntryOf<K>) => boolean;
  /** Whether it is connected (or streaming), for the dot; `null` draws no dot. */
  on: (entry: EntryOf<K>) => boolean | null;
}

/** One row per kind: a new kind of device fails to compile until it says how its row reads. */
const RAIL_ROWS: { [K in Kind]: RailRowSpec<K> } = {
  strip: {
    label: ({ strip, ordinal }, t) => {
      const transport = strip.transport;
      const name =
        transport?.kind === "wled"
          ? t("device:page.rail.wledStrip", { ip: transport.sink.ip })
          : transport?.kind === "serial"
            ? t("device:page.rail.usbStrip")
            : t("device:page.rail.unboundStrip");
      return ordinal === null ? name : `${name} ${ordinal}`;
    },
    group: "device:page.rail.strips",
    ghost: () => false,
    on: ({ connected }) => connected,
  },
  port: {
    label: ({ port }, t) => t("device:page.rail.addPort", { name: port.product ?? shortPortName(port.portName) }),
    group: "device:page.rail.found",
    ghost: () => true,
    on: () => null,
  },
  bridge: {
    label: ({ bridge, sameNameAsAnother }, t) =>
      t("device:page.rail.pairBridge", { name: sameNameAsAnother ? bridge.ip : bridgeDisplayName(bridge.name) }),
    group: "device:page.rail.found",
    ghost: () => true,
    on: () => null,
  },
  hue: {
    label: ({ bridgeName }, t) => (bridgeName === null ? t("device:page.rail.addBridge") : bridgeDisplayName(bridgeName)),
    group: "device:page.rail.hue",
    ghost: ({ bridgeName }) => bridgeName === null,
    on: ({ bridgeName, streaming }) => (bridgeName === null ? null : streaming),
  },
  add: {
    label: (_entry, t) => t("device:page.rail.addStrip"),
    group: "device:page.rail.strips",
    ghost: () => true,
    on: () => null,
  },
};

function rowSpec<K extends Kind>(entry: EntryOf<K>): RailRowSpec<K> {
  return RAIL_ROWS[entry.kind as K];
}

export function railItem(entry: DeviceRailEntry, t: TFunction): RailItem<DeviceRailEntry["id"]> {
  const spec = rowSpec(entry) as RailRowSpec<typeof entry.kind>;
  // TypeScript cannot tie `entry` to the spec its own kind picked; `rowSpec` did.
  const narrow = entry as never;
  const on = spec.on(narrow);
  return {
    id: entry.id,
    label: spec.label(narrow, t),
    group: t(spec.group),
    ghost: spec.ghost(narrow),
    dot: on === null ? undefined : { tone: on ? "on" : "off", label: t(on ? "device:page.rail.on" : "device:page.rail.off") },
    testId: `device-entry-${entry.kind}`,
  };
}
