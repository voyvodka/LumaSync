import type { TranslationKey } from "@/features/i18n/catalogue";
import { WLED_STATUS, type WledStatusCode } from "@/shared/contracts/device";

/** Every code a WLED command can answer with, in the user's words. A `Record` over the whole
 *  union so a new code cannot ship untranslated. */
export const WLED_STATUS_COPY = {
  [WLED_STATUS.DISCOVERY_OK]: "device:page.wled.status.discoveryOk",
  [WLED_STATUS.DISCOVERY_TIMEOUT]: "device:page.wled.status.discoveryTimeout",
  [WLED_STATUS.DISCOVERY_UNREACHABLE]: "device:page.wled.status.discoveryUnreachable",
  [WLED_STATUS.BRIDGE_UNREACHABLE]: "device:page.wled.status.bridgeUnreachable",
  [WLED_STATUS.PROTOCOL_MISMATCH]: "device:page.wled.status.protocolMismatch",
  [WLED_STATUS.LED_COUNT_MISMATCH]: "device:page.wled.status.ledCountMismatch",
  [WLED_STATUS.INVALID_IP]: "device:page.wled.status.invalidIp",
  [WLED_STATUS.INVALID_LED_COUNT]: "device:page.wled.status.invalidLedCount",
  [WLED_STATUS.CONNECT_OK]: "device:page.wled.status.connectOk",
  [WLED_STATUS.TEST_LIVE_CONFIRMED]: "device:page.wled.status.testLiveConfirmed",
  [WLED_STATUS.TEST_SENT_UNCONFIRMED]: "device:page.wled.status.testSentUnconfirmed",
  [WLED_STATUS.REALTIME_PORT_MISMATCH]: "device:page.wled.status.realtimePortMismatch",
  [WLED_STATUS.LIVE_LED_COUNT_MISMATCH]: "device:page.wled.status.ledCountMismatch",
  [WLED_STATUS.TEST_SEND_FAILED]: "device:page.wled.status.testSendFailed",
  [WLED_STATUS.CLIENT_BUILD_FAILED]: "device:page.wled.status.clientBuildFailed",
  [WLED_STATUS.SINK_NOT_STARTED]: "device:page.wled.status.sinkNotStarted",
  [WLED_STATUS.DISCOVERY_WORKER_FAILED]: "device:page.wled.status.workerFailed",
  [WLED_STATUS.TEST_WORKER_FAILED]: "device:page.wled.status.workerFailed",
  [WLED_STATUS.CONNECT_WORKER_FAILED]: "device:page.wled.status.workerFailed",
  [WLED_STATUS.FORGET_OK]: "device:page.wled.status.forgetOk",
  [WLED_STATUS.FORGET_FAILED]: "device:page.wled.status.forgetFailed",
} as const satisfies Record<WledStatusCode, TranslationKey>;

/** The copy for a code Rust sent; `null` for one this build does not know. */
export function wledStatusKey(code: string): TranslationKey | null {
  return Object.prototype.hasOwnProperty.call(WLED_STATUS_COPY, code) ? WLED_STATUS_COPY[code as WledStatusCode] : null;
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

/** Permissive: a dotted IPv4 or an IPv6 text form; Rust has the last word. */
export function wledAddressError(value: string): TranslationKey | null {
  const trimmed = value.trim();
  if (!trimmed) return "device:page.wled.ipRequired";
  return IPV4.test(trimmed) || IPV6.test(trimmed) ? null : "device:page.wled.invalidIp";
}
