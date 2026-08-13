// Shell-state → `startHue` projection plus the code predicates that read its
// answer. Together because every call site uses them in the same breath.

import {
  HUE_CREDENTIAL_BACKENDS,
  HUE_RUNTIME_STATUS,
  type HueCredentialBackend,
} from "@/shared/contracts/hue";

/** Bridge, credential and area selection required to open an entertainment stream. */
export interface HueStartConfig {
  bridgeIp: string;
  username: string;
  clientKey: string;
  areaId: string;
}

/** Returns `null` unless bridge, area and a pairing are all present. */
export function toHueStartConfig(state: {
  lastHueBridge?: { ip: string };
  hueAppKey?: string;
  hueClientKey?: string;
  credentialStorageBackend?: HueCredentialBackend;
  lastHueAreaId?: string;
}): HueStartConfig | null {
  const bridgeIp = state.lastHueBridge?.ip?.trim();
  const username = state.hueAppKey?.trim() ?? "";
  const clientKey = state.hueClientKey?.trim() ?? "";
  const areaId = state.lastHueAreaId?.trim();
  // An empty app key is the keychain signal, so it can no longer stand in for
  // "never paired" — the backend field has to answer that instead.
  const paired =
    !!username || state.credentialStorageBackend === HUE_CREDENTIAL_BACKENDS.KEYCHAIN;
  if (!bridgeIp || !areaId || !paired) return null;
  return { bridgeIp, username, clientKey, areaId };
}

/** All four codes that mean "the stream is up, or on its way up". */
export function isHueStartCodeOk(code: string): boolean {
  return (
    code === HUE_RUNTIME_STATUS.STREAM_RUNNING ||
    code === HUE_RUNTIME_STATUS.STREAM_RUNNING_DTLS ||
    code === HUE_RUNTIME_STATUS.STREAM_STARTING ||
    code === HUE_RUNTIME_STATUS.START_NOOP_ALREADY_ACTIVE
  );
}

/** Only a confirmed stop counts — anything else leaves the target active. */
export function isHueStopCodeOk(code: string): boolean {
  return code === HUE_RUNTIME_STATUS.STREAM_STOPPED;
}
