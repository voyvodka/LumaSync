import { invoke } from "@tauri-apps/api/core";

import { HUE_COMMANDS } from "@/shared/contracts/hue";
import type {
  HueCredentialMigrationResponse,
  HueOnboardingCommandStatus,
  HuePairBridgeResponse,
} from "@/shared/contracts/hue";

export type { HueOnboardingCommandStatus };

/** One bridge returned by discovery, before pairing. */
export interface HueBridgeSummary {
  id: string;
  ip: string;
  name: string;
  modelId?: string | null;
  softwareVersion?: string | null;
}

/** Result of `discoverHueBridges` — bridges found via cloud + mDNS, deduped by id. */
export interface HueDiscoveryResponse {
  status: HueOnboardingCommandStatus;
  bridges: HueBridgeSummary[];
}

/** Result of `verifyHueBridgeIp` — the bridge at that address, if the format and reachability check pass. */
export interface HueVerifyBridgeIpResponse {
  status: HueOnboardingCommandStatus;
  bridge: HueBridgeSummary | null;
}

export interface HuePairingCredentials {
  username: string;
  clientKey: string;
}

export type {
  HuePairBridgeResponse,
  HueCredentialMigrationResponse,
} from "@/shared/contracts/hue";

/** Result of `validateHueCredentials` — whether the stored username/clientKey still authenticate. */
export interface HueValidateCredentialsResponse {
  status: HueOnboardingCommandStatus;
  valid: boolean;
}

export interface HueEntertainmentAreaSummary {
  id: string;
  name: string;
  roomName?: string | null;
  channelCount: number;
  activeStreamer: boolean;
}

export interface HueEntertainmentAreaListResponse {
  status: HueOnboardingCommandStatus;
  areas: HueEntertainmentAreaSummary[];
}

/** Whether starting the Hue stream would succeed right now, and why not if it wouldn't. */
export interface HueStreamReadiness {
  ready: boolean;
  reasons: string[];
}

export interface HueStreamReadinessResponse {
  status: HueOnboardingCommandStatus;
  readiness: HueStreamReadiness;
}

/** Discover bridges on the network via cloud discovery and mDNS in parallel. */
export async function discoverHueBridges(): Promise<HueDiscoveryResponse> {
  return invoke<HueDiscoveryResponse>(HUE_COMMANDS.DISCOVER_BRIDGES);
}

/** Validate that a manually entered bridge IP is a well-formed, reachable address. */
export async function verifyHueBridgeIp(bridgeIp: string): Promise<HueVerifyBridgeIpResponse> {
  return invoke<HueVerifyBridgeIpResponse>(HUE_COMMANDS.VERIFY_BRIDGE_IP, { bridgeIp });
}

/**
 * Request pairing with the bridge at `bridgeIp`. Requires the physical link
 * button to have been pressed recently; returns `HUE_PAIRING_PENDING_LINK_BUTTON` otherwise.
 */
export async function pairHueBridge(bridgeIp: string): Promise<HuePairBridgeResponse> {
  return invoke<HuePairBridgeResponse>(HUE_COMMANDS.PAIR_BRIDGE, { bridgeIp });
}

/** Move existing plaintext Hue credentials into the OS keychain; safe to call repeatedly. */
export async function migrateHueCredentials(
  username: string,
  clientKey: string,
): Promise<HueCredentialMigrationResponse> {
  return invoke<HueCredentialMigrationResponse>(HUE_COMMANDS.MIGRATE_CREDENTIALS, {
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
  return invoke<HueValidateCredentialsResponse>(HUE_COMMANDS.VALIDATE_CREDENTIALS, {
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
  return invoke<HueEntertainmentAreaListResponse>(HUE_COMMANDS.LIST_ENTERTAINMENT_AREAS, {
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
  return invoke<HueStreamReadinessResponse>(HUE_COMMANDS.CHECK_STREAM_READINESS, {
    bridgeIp,
    username,
    areaId,
  });
}

/** One resolved entertainment channel: its bridge-reported position and auto-detected screen region. */
export interface HueAreaChannelInfo {
  index: number;
  positionX: number;
  positionY: number;
  lightCount: number;
  autoRegion: string;
}

/** Fetch per-channel metadata for the area — light count and auto-detected screen region — for the room-map editor. */
export async function getHueAreaChannels(
  bridgeIp: string,
  username: string,
  areaId: string,
): Promise<HueAreaChannelInfo[]> {
  return invoke<HueAreaChannelInfo[]>(HUE_COMMANDS.GET_AREA_CHANNELS, {
    bridgeIp,
    username,
    areaId,
  });
}
