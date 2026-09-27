import { bridgeDisplayName } from "@/features/hue/model/bridgeIdentity";
import type { HueBridgeSummary } from "@/shared/contracts/hue";
import type { LedStrip } from "@/shared/contracts/strips";
import type { DevicePort } from "../types";
import type { DeviceCategory } from "./deviceCategories";

/** One row of the Devices rail: the page it opens is that device's own. */
export type DeviceRailEntry =
  | {
      kind: "strip";
      id: `strip:${string}`;
      strip: LedStrip;
      /** 2, 3… among strips on the same kind of transport; `null` for the only one. A name that
       *  holds still whether the controller is plugged in or not, until strips can be named. */
      ordinal: number | null;
      connected: boolean;
    }
  /** A supported port plugged in that no strip is bound to yet. */
  | { kind: "port"; id: `port:${string}`; port: DevicePort }
  /** A bridge found on the network and not paired. `sameNameAs` another found one: name it by address. */
  | { kind: "bridge"; id: `bridge:${string}`; bridge: HueBridgeSummary; sameNameAsAnother: boolean }
  | { kind: "hue"; id: "hue"; bridgeName: string | null; streaming: boolean }
  | { kind: "add"; id: "add" };

export type DeviceRailEntryId = DeviceRailEntry["id"];

export interface DeviceRailInput {
  strips: readonly LedStrip[];
  ports: readonly DevicePort[];
  connectedPort: string | null;
  activeWledIp: string | null;
  /** `bridgeName` is the paired bridge's; `found` every bridge discovery answered with. */
  hue: { bridgeName: string | null; pairedBridgeId: string | null; streaming: boolean; found: readonly HueBridgeSummary[] };
}

/** Strips (the order they are stored in) and "add a strip", the bridge, then what was found and not
 *  added — ports plugged in, bridges on the network. Those come and go with a cable or a scan, so they
 *  sit last: a row arriving never moves one above it. */
export function deviceRailEntries(input: DeviceRailInput): DeviceRailEntry[] {
  const bound = new Set(
    input.strips.flatMap((strip) => (strip.transport?.kind === "serial" ? [strip.transport.portName] : [])),
  );
  const kindOf = (strip: LedStrip) => strip.transport?.kind ?? "none";
  const strips: DeviceRailEntry[] = input.strips.map((strip, index) => {
    const transport = strip.transport;
    const sameKind = input.strips.filter((other) => kindOf(other) === kindOf(strip));
    const place = input.strips.slice(0, index + 1).filter((other) => kindOf(other) === kindOf(strip)).length;
    return {
      kind: "strip",
      id: `strip:${strip.id}`,
      strip,
      ordinal: sameKind.length > 1 ? place : null,
      connected:
        transport?.kind === "serial"
          ? input.connectedPort === transport.portName
          : transport?.kind === "wled"
            ? input.activeWledIp === transport.sink.ip
            : false,
    };
  });
  const found: DeviceRailEntry[] = input.ports
    .filter((port) => port.isSupported && !bound.has(port.portName))
    .map((port) => ({ kind: "port", id: `port:${port.portName}`, port }));
  const unpaired = input.hue.found.filter((bridge) => bridge.id !== input.hue.pairedBridgeId);
  const bridges: DeviceRailEntry[] = unpaired.map((bridge) => ({
    kind: "bridge",
    id: `bridge:${bridge.id}`,
    bridge,
    sameNameAsAnother: unpaired.some(
      (other) => other.id !== bridge.id && bridgeDisplayName(other.name) === bridgeDisplayName(bridge.name),
    ),
  }));
  return [
    ...strips,
    { kind: "add", id: "add" },
    { kind: "hue", id: "hue", bridgeName: input.hue.bridgeName, streaming: input.hue.streaming },
    ...found,
    ...bridges,
  ];
}

/** The last path segment of a port, for a strip whose controller reports no product name. */
export function shortPortName(portName: string): string {
  return portName.split(/[\\/]/).pop() ?? portName;
}

/** What the shell's notices and deep links call the row: the Hue row, or anything strip-shaped. */
export function categoryOfEntry(entry: DeviceRailEntry): DeviceCategory {
  return entry.kind === "hue" || entry.kind === "bridge" ? "hue" : "strips";
}

/** Where a deep link lands: the bridge, or the first strip (else "add a strip"). */
export function entryForCategory(entries: readonly DeviceRailEntry[], category: DeviceCategory): DeviceRailEntryId {
  if (category === "hue") return "hue";
  return entries.find((entry) => entry.kind === "strip")?.id ?? "add";
}
