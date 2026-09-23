import { useEffect, useState } from "react";
import type { FirmwarePixelLayout, FirmwareProfile } from "@/shared/contracts/device";
import {
  firmwareProfileEvents as defaultFirmwareProfileEvents,
  type FirmwareProfileEvent,
  type FirmwareProfileEventBus,
} from "./firmwareProfileEvents";

export interface UseAdvertisedFirmwareProfileDeps {
  /** Inject for tests; defaults to the process-wide singleton bus. */
  firmwareProfileEvents?: FirmwareProfileEventBus;
}

const UNKNOWN_FIRMWARE: FirmwareProfileEvent = {
  advertisedFirmwareProfile: undefined,
  advertisedPixelLayout: undefined,
};

// Read-only snapshot, no controller mount / port scan — unknown until some
// controller has connected or run a health check this session (Bug H4).
function useAdvertisedFirmware(deps: UseAdvertisedFirmwareProfileDeps): FirmwareProfileEvent {
  const bus = deps.firmwareProfileEvents ?? defaultFirmwareProfileEvents;
  const [advertised, setAdvertised] = useState<FirmwareProfileEvent>(UNKNOWN_FIRMWARE);

  useEffect(() => bus.subscribe(setAdvertised), [bus]);

  return advertised;
}

export function useAdvertisedFirmwareProfile(
  deps: UseAdvertisedFirmwareProfileDeps = {},
): FirmwareProfile | undefined {
  return useAdvertisedFirmware(deps).advertisedFirmwareProfile;
}

export function useAdvertisedPixelLayout(
  deps: UseAdvertisedFirmwareProfileDeps = {},
): FirmwarePixelLayout | undefined {
  return useAdvertisedFirmware(deps).advertisedPixelLayout;
}
