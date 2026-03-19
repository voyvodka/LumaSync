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

export function shouldTriggerConnectOnSelectionChange(): false {
  return false;
}

export function canConnectSelectedPort(
  selectedPort: string | null,
  isScanning: boolean,
): boolean {
  if (isScanning) {
    return false;
  }

  return selectedPort !== null;
}

export interface RefreshSelectionResolution {
  selectedPort: string | null;
  missingSelection: boolean;
}

export function resolveSelectionAfterRefresh(
  ports: DevicePort[],
  currentSelectedPort: string | null,
  lastSuccessfulPort?: string,
): RefreshSelectionResolution {
  const ordered = [...groupAndSortPorts(ports).supported, ...groupAndSortPorts(ports).other];
  const hasPort = (portName: string | null | undefined): portName is string =>
    Boolean(portName) && ordered.some((port) => port.portName === portName);

  if (hasPort(currentSelectedPort)) {
    return {
      selectedPort: currentSelectedPort,
      missingSelection: false,
    };
  }

  if (currentSelectedPort) {
    return {
      selectedPort: null,
      missingSelection: true,
    };
  }

  if (hasPort(lastSuccessfulPort)) {
    return {
      selectedPort: lastSuccessfulPort,
      missingSelection: false,
    };
  }

  return {
    selectedPort: null,
    missingSelection: false,
  };
}
