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
    serial: { ports: [], connectedPort: null },
    wled: { devices: [], connectedHost: null },
    hue: {
      bridges: [],
      appKey: null,
      reachable: true,
      credentialValid: true,
      areas: [],
      channels: [],
      streaming: false,
      linkButtonPressesRemaining: 0,
    },
    displays: DISPLAYS,
    capture: { permissionGranted: true },
    lighting: { mode: "off" },
    persistFails: false,
    forcedFailures: new Set<string>(),
    extraLatencyMs: 0,
    shellState: { schemaVersion: 3, uiMode: "full", trayHintShown: true },
  };
}

const PORTS = [
  { name: "/dev/cu.usbserial-1420", supported: true, product: "CH340 USB Serial" },
  { name: "/dev/cu.debug-console", supported: false, product: null },
];

const BRIDGE = { id: "bridge-c8a76249", ip: "192.168.1.180", name: "Hue Bridge" };

const AREAS = [
  { id: "area-living", name: "Living room", channelCount: 4 },
  { id: "area-desk", name: "Desk", channelCount: 2 },
];

const CHANNELS = [
  { index: 0, name: "Left strip" },
  { index: 1, name: "Right strip" },
  { index: 2, name: "Ceiling" },
  { index: 3, name: "Lamp" },
];

function furnished(): MockWorld {
  const w = base();
  w.serial = { ports: PORTS, connectedPort: PORTS[0].name };
  w.wled = {
    devices: [{ host: "192.168.1.42", name: "WLED Panel", ledCount: 120 }],
    connectedHost: "192.168.1.42",
  };
  w.hue = {
    bridges: [BRIDGE],
    appKey: "mock-application-key",
    reachable: true,
    credentialValid: true,
    areas: AREAS,
    channels: CHANNELS,
    streaming: true,
    linkButtonPressesRemaining: 0,
  };
  w.lighting = { mode: "ambilight" };
  w.shellState = {
    ...w.shellState,
    lastSuccessfulPort: PORTS[0].name,
    lastOutputTargets: ["usb", "hue"],
    lastWledSink: { host: "192.168.1.42", port: 4048, protocol: "ddp" },
    lastHueBridge: { id: BRIDGE.id, internalipaddress: BRIDGE.ip, name: BRIDGE.name },
    lastHueAreaId: AREAS[0].id,
    hueAppKey: "mock-application-key",
    hueClientKey: "6d6f636b636c69656e746b6579303030",
    hueOnboardingStep: "done",
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
      startAnchor: "top",
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
      w.serial = { ports: PORTS, connectedPort: PORTS[0].name };
      w.lighting = { mode: "ambilight" };
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
      w.serial = { ports: [], connectedPort: null };
      w.wled = { devices: [], connectedHost: null };
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
      w.hue.areas = [{ id: "area-living", name: "Living room", channelCount: 0 }];
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
      w.lighting = { mode: "off" };
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
