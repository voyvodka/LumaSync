import type { ModeCommandResult } from "@/features/mode/modeApi";
import { LIGHTING_MODE_KIND, type LightingModeConfig } from "@/features/mode/model/contracts";
import { LIGHTING_MODE_STATUS } from "@/shared/contracts/lighting";

/** Accepted `set_lighting_mode` reply, typed as the real result so a mock cannot
 *  drift into a shape the backend can never send. The orchestrator decides
 *  acceptance by reading `mode`, so omitting it is a false green. */
export function appliedResult(payload: LightingModeConfig): ModeCommandResult {
  const code =
    payload.kind === LIGHTING_MODE_KIND.OFF
      ? LIGHTING_MODE_STATUS.LIGHTING_MODE_STOPPED
      : payload.kind === LIGHTING_MODE_KIND.SOLID
        ? LIGHTING_MODE_STATUS.SOLID_MODE_APPLIED
        : LIGHTING_MODE_STATUS.AMBILIGHT_MODE_STARTED;

  return {
    active: payload.kind !== LIGHTING_MODE_KIND.OFF,
    mode: payload,
    status: { code, message: "Applied.", details: null },
  };
}
