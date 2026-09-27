import type { LedCalibrationConfig } from "@/shared/contracts/calibration";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";
import type { LightingModeKind } from "@/shared/contracts/mode";
import type { LocalSink } from "@/features/device/localSink";
import type { OsName } from "./helpLinks";

export interface DiagnosticsInput {
  appName: string;
  appVersion: string;
  os: OsName | null;
  channel: string;
  mode: LightingModeKind;
  outputs: readonly HueRuntimeTarget[];
  localSink: LocalSink | null;
  calibration: LedCalibrationConfig | undefined;
  hue: { configured: boolean; reachable: boolean; streaming: boolean; reconnecting: boolean };
  uiZoom: number;
  motion: string;
  language: string;
}

/**
 * What a bug report needs about this install, as plain text to paste. English, like the issue
 * template it goes into. Nothing that points at the user's network or accounts: no addresses, no
 * bridge or device ids, no keys — a serial port's name and the USB product string are kept, since
 * they say which adapter it is and nothing about where.
 */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const { calibration: layout, hue, localSink: sink } = input;
  const local = !sink
    ? "none"
    : sink.transport === "serial"
      ? `USB strip on ${sink.id}${sink.product ? ` (${sink.product})` : ""}`
      : "WLED panel";
  const counts = layout?.counts;
  const leds = !layout
    ? "not set up"
    : `${layout.totalLeds} LEDs${counts ? ` (top ${counts.top}, right ${counts.right}, bottom ${counts.bottom}, left ${counts.left})` : ""}`;
  const hueState = !hue.configured
    ? "not set up"
    : [hue.reachable ? "reachable" : "unreachable", hue.reconnecting ? "reconnecting" : hue.streaming ? "streaming" : "idle"].join(", ");
  return [
    `${input.appName} ${input.appVersion}${input.os ? ` · ${input.os}` : ""}`,
    `Update channel: ${input.channel}`,
    `Mode: ${input.mode} · outputs: ${input.outputs.length ? input.outputs.join(", ") : "none"}`,
    `Local output: ${local}`,
    `LED layout: ${leds}`,
    `Hue: ${hueState}`,
    `Interface: ${input.uiZoom}% · motion: ${input.motion} · language: ${input.language}`,
  ].join("\n");
}
