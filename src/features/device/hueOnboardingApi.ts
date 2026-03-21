import { invoke } from "@tauri-apps/api/core";

import { HUE_COMMANDS } from "../../shared/contracts/hue";

export interface CommandStatus {
  code: string;
  message: string;
  details: string | null;
}

export interface HueBridgeSummary {
  id: string;
  ip: string;
  name: string;
  modelId?: string;
  softwareVersion?: string;
}

export interface HueDiscoveryResponse {
  status: CommandStatus;
  bridges: HueBridgeSummary[];
}

export interface HueVerifyBridgeIpResponse {
  status: CommandStatus;
  bridge: HueBridgeSummary | null;
}

export interface HuePairingCredentials {
  username: string;
  clientKey: string;
}

export interface HuePairBridgeResponse {
  status: CommandStatus;
  credentials: HuePairingCredentials | null;
}

export interface HueValidateCredentialsResponse {
  status: CommandStatus;
  valid: boolean;
}

export interface HueEntertainmentAreaSummary {
  id: string;
  name: string;
  roomName?: string;
  channelCount?: number;
  activeStreamer?: boolean;
}

export interface HueEntertainmentAreaListResponse {
  status: CommandStatus;
  areas: HueEntertainmentAreaSummary[];
}

export interface HueStreamReadiness {
  ready: boolean;
  reasons: string[];
}

export interface HueStreamReadinessResponse {
  status: CommandStatus;
  readiness: HueStreamReadiness;
}

export async function discoverHueBridges(): Promise<HueDiscoveryResponse> {
  return invoke<HueDiscoveryResponse>(HUE_COMMANDS.DISCOVER_BRIDGES);
}

export async function verifyHueBridgeIp(bridgeIp: string): Promise<HueVerifyBridgeIpResponse> {
  return invoke<HueVerifyBridgeIpResponse>(HUE_COMMANDS.VERIFY_BRIDGE_IP, { bridgeIp });
}

export async function pairHueBridge(bridgeIp: string): Promise<HuePairBridgeResponse> {
  return invoke<HuePairBridgeResponse>(HUE_COMMANDS.PAIR_BRIDGE, { bridgeIp });
}

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

export async function listHueEntertainmentAreas(
  bridgeIp: string,
  username: string,
): Promise<HueEntertainmentAreaListResponse> {
  return invoke<HueEntertainmentAreaListResponse>(HUE_COMMANDS.LIST_ENTERTAINMENT_AREAS, {
    bridgeIp,
    username,
  });
}

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
