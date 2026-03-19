import type { DevicePort } from "./types";

export interface GroupedPorts {
  supported: DevicePort[];
  other: DevicePort[];
}

function sortPorts(ports: DevicePort[]): DevicePort[] {
  return [...ports].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

export function groupAndSortPorts(ports: DevicePort[]): GroupedPorts {
  const supported = ports.filter((port) => port.isSupported);
  const other = ports.filter((port) => !port.isSupported);

  return {
    supported: sortPorts(supported),
    other: sortPorts(other),
  };
}

export function resolveInitialSelection(
  ports: DevicePort[],
  lastSuccessfulPort?: string,
): string | null {
  const grouped = groupAndSortPorts(ports);
  const ordered = [...grouped.supported, ...grouped.other];

  if (lastSuccessfulPort) {
    const remembered = ordered.find((port) => port.portName === lastSuccessfulPort);
    if (remembered) {
      return remembered.portName;
    }
  }

  if (grouped.supported.length > 0) {
    return grouped.supported[0].portName;
  }

  return null;
}

export function shouldPersistLastSuccessfulPort(
  selectedPort: string | null,
  connectionSucceeded: boolean,
): boolean {
  return Boolean(selectedPort) && connectionSucceeded;
}
