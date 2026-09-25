import {
  HUE_COMMANDS,
  type HueAreaChannelListResponse,
  type HueCredentialMigrationResponse,
  type HueDiscoveryResponse,
  type HueEntertainmentAreaListResponse,
  type HueForgetStatus,
  type HueIdentifyStatus,
  type HueLightNamesResponse,
  type HuePairBridgeResponse,
  type HueStreamReadinessResponse,
  type HueValidateCredentialsResponse,
  type HueVerifyBridgeIpResponse,
} from "@/shared/contracts/hue";
import { invokeCommand } from "@/shared/ipcApi";

export type {
  HueAreaChannelInfo,
  HueAreaChannelListResponse,
  HueAreaChannelsCommandStatus,
  HueBridgeSummary,
  HueCredentialMigrationResponse,
  HueDiscoveryResponse,
  HueEntertainmentAreaListResponse,
  HueEntertainmentAreaSummary,
  HueOnboardingCommandStatus,
  HuePairBridgeResponse,
  HuePairingCredentials,
  HueStreamReadiness,
  HueStreamReadinessResponse,
  HueValidateCredentialsResponse,
  HueVerifyBridgeIpResponse,
} from "@/shared/contracts/hue";

/** Discover bridges on the network via cloud discovery and mDNS in parallel. */
export async function discoverHueBridges(): Promise<HueDiscoveryResponse> {
  return invokeCommand(HUE_COMMANDS.DISCOVER_BRIDGES);
}

/** Validate that a manually entered bridge IP is a well-formed, reachable address. */
export async function verifyHueBridgeIp(bridgeIp: string): Promise<HueVerifyBridgeIpResponse> {
  return invokeCommand(HUE_COMMANDS.VERIFY_BRIDGE_IP, { bridgeIp });
}

/**
 * Request pairing with the bridge at `bridgeIp`. One attempt: returns
 * `HUE_PAIRING_LINK_BUTTON_NOT_PRESSED` until the physical link button has been
 * pressed, so the caller owns any retrying.
 */
export async function pairHueBridge(bridgeIp: string): Promise<HuePairBridgeResponse> {
  return invokeCommand(HUE_COMMANDS.PAIR_BRIDGE, { bridgeIp });
}

/** Move existing plaintext Hue credentials into the OS keychain; safe to call repeatedly. */
export async function migrateHueCredentials(
  username: string,
  clientKey: string,
): Promise<HueCredentialMigrationResponse> {
  return invokeCommand(HUE_COMMANDS.MIGRATE_CREDENTIALS, {
    username,
    clientKey,
  });
}

/** Check whether a stored bridge/username pair still authenticates against the bridge. */
export async function validateHueCredentials(
  bridgeIp: string,
  username: string,
  clientKey?: string,
): Promise<HueValidateCredentialsResponse> {
  return invokeCommand(HUE_COMMANDS.VALIDATE_CREDENTIALS, {
    bridgeIp,
    username,
    clientKey,
  });
}

/** List the entertainment areas configured on the bridge, for the area-select onboarding step. */
export async function listHueEntertainmentAreas(
  bridgeIp: string,
  username: string,
): Promise<HueEntertainmentAreaListResponse> {
  return invokeCommand(HUE_COMMANDS.LIST_ENTERTAINMENT_AREAS, {
    bridgeIp,
    username,
  });
}

/** Poll whether the selected area/credentials would let the Hue stream start right now (cached read). */
export async function checkHueStreamReadiness(
  bridgeIp: string,
  username: string,
  areaId: string,
): Promise<HueStreamReadinessResponse> {
  return invokeCommand(HUE_COMMANDS.CHECK_STREAM_READINESS, {
    bridgeIp,
    username,
    areaId,
  });
}

/** Fetch per-channel metadata for the area — light count and auto-detected screen region — for the room-map editor. Never throws; check `status.code`. */
export async function getHueAreaChannels(
  bridgeIp: string,
  username: string,
  areaId: string,
): Promise<HueAreaChannelListResponse> {
  return invokeCommand(HUE_COMMANDS.GET_AREA_CHANNELS, {
    bridgeIp,
    username,
    areaId,
  });
}

/** Forget the paired bridge: Hue leaves the lighting, the saved outputs and
 * the saved pairing, and its key pair leaves the keychain. Never throws;
 * check `code`. */
export async function forgetHueBridge(bridgeId: string): Promise<HueForgetStatus> {
  return invokeCommand(HUE_COMMANDS.FORGET_BRIDGE, { bridgeId });
}

/** The Hue app's names for `lightIds`, from one read of the bridge's lights. */
export async function getHueLightNames(
  bridgeIp: string,
  username: string,
  lightIds: string[],
): Promise<HueLightNamesResponse> {
  return invokeCommand(HUE_COMMANDS.GET_LIGHT_NAMES, { bridgeIp, username, lightIds });
}

/** Blink each light once; refused while a stream owns them. */
export async function identifyHueLights(
  bridgeIp: string,
  username: string,
  lightIds: string[],
): Promise<HueIdentifyStatus> {
  return invokeCommand(HUE_COMMANDS.IDENTIFY_LIGHTS, { bridgeIp, username, lightIds });
}
