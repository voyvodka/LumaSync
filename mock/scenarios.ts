/**
 * The scenario catalogue.
 *
 * Every entry past the first two exists because the real app once got that
 * state wrong. They are read out of `CHANGELOG.md`'s Fixed section rather than
 * imagined: the Hue channel panel that vanished when an area had no lights, the
 * bridge that emptied the list when it went unreachable, the expired key that
 * reported an empty area, the Hue-only session whose signal readout showed
 * zeros. An empty state and a failed state look identical from the outside and
 * that is precisely why both need to be one click away.
 */

import { SHELL_STATE_SCHEMA_VERSION } from "../src/shared/contracts/shell";
import type { MockWorld } from "./state";

export const SCENARIO_IDS = [
  "empty",
  "furnished",
  "usb-only",
  "hue-only",
  "hue-area-empty",
  "hue-unreachable",
  "hue-key-expired",
  "hue-link-button",
  "capture-denied",
  "persist-failing",
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

export interface Scenario {
  id: ScenarioId;
  label: string;
  /** One line, shown under the label in the picker. Says what is being reproduced. */
  summary: string;
  build: () => MockWorld;
}

const DISPLAYS = [
  { id: "display-1", name: "Built-in Retina Display", width: 3600, height: 2338 },
  { id: "display-2", name: "DELL U2723QE", width: 2560, height: 1440 },
];

/** Everything off. Each scenario below turns on only what it needs. */
function base(): MockWorld {
  return {
    scenario: "empty",
    generation: 0,
    serial: { ports: [], connectedPort: null, healthFailsAt: null },
    wled: { devices: [], connectedHost: null, testOutcome: "WLED_TEST_LIVE_CONFIRMED" },
    hue: {
      bridges: [],
      selectedBridgeId: null,
      appKey: null,
      reachable: true,
      credentialValid: true,
      areas: [],
      selectedAreaId: null,
      channels: [],
      streaming: false,
      linkButtonPressesRemaining: 0,
      everActive: false,
      totalReconnects: 0,
      activeStreamerElsewhere: false,
    },
    displays: DISPLAYS,
    capture: { permissionGranted: true },
    lighting: { mode: { kind: "off" } },
    telemetry: {
      captureFps: 0,
      sendFps: 0,
      queueHealth: "healthy",
      frameLatencyMs: 0,
      linkConstrained: false,
      linkMaxFps: 0,
      lastCaptureErrorCode: null,
      lastCaptureErrorAtSecs: null,
    },
    persistFails: false,
    forcedCodes: {},
    forcedThrows: [],
    extraLatencyMs: 0,
    shell: { viewport: "free", notificationPermission: "granted", autostartEnabled: false },
    // The version the app is actually on. Shipping an older one made every
    // boot run the 3→4→5→6 migrations, so the state the app saw was never the
    // state this fixture declares — and nothing said so.
    shellState: { schemaVersion: SHELL_STATE_SCHEMA_VERSION, uiMode: "full", trayHintShown: true },
  };
}

const PORTS: MockWorld["serial"]["ports"] = [
  {
    name: "/dev/cu.usbserial-1420",
    supported: true,
    vid: 0x1a86,
    pid: 0x7523,
    manufacturer: "wch.cn",
    product: "CH340 USB Serial",
    connectOutcome: "OK",
    firmwareProfile: "lumasync-v1",
    chipType: "ws2812b-grb",
  },
  {
    name: "/dev/cu.debug-console",
    supported: false,
    vid: 0x0000,
    pid: 0x0000,
    manufacturer: null,
    product: null,
    connectOutcome: "FAILED",
    firmwareProfile: "lumasync-v1",
    chipType: "ws2812b-grb",
  },
];

const BRIDGE = { id: "bridge-c8a76249", ip: "192.168.1.180", name: "Hue Bridge" };

const AREAS: MockWorld["hue"]["areas"] = [
  { id: "area-living", name: "Living room", channelCount: 4, roomName: "Living room", activeStreamer: false },
  { id: "area-desk", name: "Desk", channelCount: 2, roomName: "Study", activeStreamer: false },
];

const CHANNELS = [
  { index: 0, name: "Left strip" },
  { index: 1, name: "Right strip" },
  { index: 2, name: "Ceiling" },
  { index: 3, name: "Lamp" },
];

function furnished(): MockWorld {
  const w = base();
  w.serial = { ports: PORTS, connectedPort: PORTS[0].name, healthFailsAt: null };
  w.wled = {
    devices: [{ host: "192.168.1.42", name: "WLED Panel", ledCount: 120, port: 4048, protocol: "ddp" }],
    connectedHost: "192.168.1.42",
    testOutcome: "WLED_TEST_LIVE_CONFIRMED",
  };
  w.hue = {
    bridges: [BRIDGE],
    selectedBridgeId: BRIDGE.id,
    appKey: "mock-application-key",
    reachable: true,
    credentialValid: true,
    areas: AREAS,
    selectedAreaId: AREAS[0].id,
    channels: CHANNELS,
    streaming: true,
    linkButtonPressesRemaining: 0,
    everActive: true,
    totalReconnects: 0,
    activeStreamerElsewhere: false,
  };
  w.lighting = { mode: { kind: "ambilight" } };
  w.telemetry = {
    captureFps: 58.4,
    sendFps: 58.1,
    queueHealth: "healthy",
    frameLatencyMs: 4.2,
    linkConstrained: false,
    linkMaxFps: 74,
    lastCaptureErrorCode: null,
    lastCaptureErrorAtSecs: null,
  };
  w.shellState = {
    ...w.shellState,
    lastSuccessfulPort: PORTS[0].name,
    lastOutputTargets: ["usb", "hue"],
    lastWledSink: { ip: "192.168.1.42", port: 4048, ledCount: 120, protocol: "ddp" },
    lastHueBridge: { id: BRIDGE.id, ip: BRIDGE.ip, name: BRIDGE.name },
    lastHueAreaId: AREAS[0].id,
    hueAppKey: "mock-application-key",
    hueClientKey: "6d6f636b636c69656e746b6579303030",
    hueOnboardingStep: "ready",
    hueCredentialStatus: "valid",
    credentialStorageBackend: "keychain",
    lightingMode: { kind: "ambilight" },
    // Without a calibration the Lights screen opens on "calibration required"
    // and every LED count reads zero, so a furnished world needs one.
    ledCalibration: {
      templateId: null,
      counts: { top: 60, right: 22, bottom: 60, left: 22 },
      bottomMissing: 0,
      cornerOwnership: "horizontal",
      visualPreset: "subtle",
      startAnchor: "top-start",
      direction: "cw",
      totalLeds: 164,
    },
  };
  return w;
}

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  empty: {
    id: "empty",
    label: "Nothing configured",
    summary: "First run. No strip, no bridge, no WLED — the onboarding path.",
    build: () => ({ ...base(), scenario: "empty" }),
  },
  furnished: {
    id: "furnished",
    label: "Fully furnished",
    summary: "USB strip, paired bridge streaming, WLED panel, two displays.",
    build: () => ({ ...furnished(), scenario: "furnished" }),
  },
  "usb-only": {
    id: "usb-only",
    label: "USB only",
    summary: "A connected strip and no Hue at all.",
    build: () => {
      const w = base();
      w.serial = { ports: PORTS, connectedPort: PORTS[0].name, healthFailsAt: null };
      w.lighting = { mode: { kind: "ambilight" } };
      w.shellState = {
        ...w.shellState,
        lastSuccessfulPort: PORTS[0].name,
        lastOutputTargets: ["usb"],
        lightingMode: { kind: "ambilight" },
      };
      return { ...w, scenario: "usb-only" };
    },
  },
  "hue-only": {
    id: "hue-only",
    label: "Hue only",
    summary: "Bridge streaming, no USB. The signal readout used to show zeros here.",
    build: () => {
      const w = furnished();
      w.serial = { ports: [], connectedPort: null, healthFailsAt: null };
      w.wled = { devices: [], connectedHost: null, testOutcome: "WLED_TEST_LIVE_CONFIRMED" };
      return { ...w, scenario: "hue-only" };
    },
  },
  "hue-area-empty": {
    id: "hue-area-empty",
    label: "Hue area has no lights",
    summary: "Bridge answers, the area is genuinely empty. The panel used to vanish.",
    build: () => {
      const w = furnished();
      w.hue.channels = [];
      w.hue.areas = [
        { id: "area-living", name: "Living room", channelCount: 0, roomName: "Living room", activeStreamer: false },
      ];
      w.hue.selectedAreaId = "area-living";
      w.hue.streaming = false;
      return { ...w, scenario: "hue-area-empty" };
    },
  },
  "hue-unreachable": {
    id: "hue-unreachable",
    label: "Hue bridge unreachable",
    summary: "Paired but off the network. Must stay distinct from an empty area.",
    build: () => {
      const w = furnished();
      w.hue.reachable = false;
      w.hue.streaming = false;
      return { ...w, scenario: "hue-unreachable" };
    },
  },
  "hue-key-expired": {
    id: "hue-key-expired",
    label: "Hue key expired",
    summary: "The bridge rejects the key. Used to surface as an empty area.",
    build: () => {
      const w = furnished();
      w.hue.credentialValid = false;
      w.hue.channels = [];
      w.hue.streaming = false;
      return { ...w, scenario: "hue-key-expired" };
    },
  },
  "hue-link-button": {
    id: "hue-link-button",
    label: "Hue mid-pairing",
    summary: "Discovered, unpaired. Pairing succeeds on the third poll.",
    build: () => {
      const w = base();
      w.hue.bridges = [BRIDGE];
      w.hue.selectedBridgeId = BRIDGE.id;
      w.hue.linkButtonPressesRemaining = 3;
      return { ...w, scenario: "hue-link-button" };
    },
  },
  "capture-denied": {
    id: "capture-denied",
    label: "Capture permission denied",
    summary: "macOS screen recording refused — hard to produce by hand.",
    build: () => {
      const w = furnished();
      w.capture = { permissionGranted: false };
      w.lighting = { mode: { kind: "off" } };
      return { ...w, scenario: "capture-denied" };
    },
  },
  "persist-failing": {
    id: "persist-failing",
    label: "Saving fails",
    summary: "Every write to the store is refused. Exercises the persist banners.",
    build: () => ({ ...furnished(), persistFails: true, scenario: "persist-failing" }),
  },
};

export const DEFAULT_SCENARIO: ScenarioId = "furnished";
