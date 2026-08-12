import { useEffect, useState } from "react";
import type { FirmwareProfile } from "@/shared/contracts/device";
import {
  firmwareProfileEvents as defaultFirmwareProfileEvents,
  type FirmwareProfileEventBus,
} from "./firmwareProfileEvents";

export interface UseAdvertisedFirmwareProfileDeps {
  /** Inject for tests; defaults to the process-wide singleton bus. */
  firmwareProfileEvents?: FirmwareProfileEventBus;
}

// Read-only snapshot, no controller mount / port scan — `undefined` until
// some controller's health check has run this session (Bug H4).
export function useAdvertisedFirmwareProfile(
  deps: UseAdvertisedFirmwareProfileDeps = {},
): FirmwareProfile | undefined {
  const bus = deps.firmwareProfileEvents ?? defaultFirmwareProfileEvents;
  const [advertised, setAdvertised] = useState<FirmwareProfile | undefined>(undefined);

  useEffect(() => bus.subscribe((event) => setAdvertised(event.advertisedFirmwareProfile)), [bus]);

  return advertised;
}
