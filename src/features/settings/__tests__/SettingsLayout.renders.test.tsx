// Which sections a shell change re-renders. Every section is a counting stub;
// the layout, its panels and the four stores are real, so a count that moves
// is a render the stores or the memo boundaries let through.

import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SECTION_IDS, type SectionId } from "@/shared/contracts/shell";
import type { LightingModeConfig } from "@/shared/contracts/mode";
import { renderWithShellStores } from "@/test/shellProviders";

const renders: Record<string, number> = {};
const count = (name: string) => {
  renders[name] = (renders[name] ?? 0) + 1;
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: () => Promise.resolve({}), save: () => Promise.resolve() },
}));

vi.mock("../sections/LightsSection", () => ({
  LightsSection: ({ mode, hueStreaming }: { mode: LightingModeConfig; hueStreaming: boolean }) => {
    count("lights");
    return (
      <>
        <p data-testid="lights-mode">{mode.kind}</p>
        <p data-testid="lights-hue-streaming">{String(hueStreaming)}</p>
      </>
    );
  },
}));

vi.mock("../sections/SystemSection", () => ({
  SystemSection: ({ isCheckingForUpdates }: { isCheckingForUpdates: boolean }) => {
    count("system");
    return <p data-testid="system-checking">{String(isCheckingForUpdates)}</p>;
  },
}));

vi.mock("../sections/DeviceSection", () => ({
  DeviceSection: ({ categoryRequest }: { categoryRequest: { category: string } | null }) => {
    count("devices");
    return <p data-testid="devices-category">{categoryRequest?.category ?? ""}</p>;
  },
}));

vi.mock("@/features/room-map/ui/RoomMapEditor", () => ({
  RoomMapEditor: () => {
    count("roomMap");
    return <p data-testid="room-map" />;
  },
}));

vi.mock("@/features/calibration/ui/CalibrationPage", () => ({
  CalibrationPage: () => {
    count("calibration");
    return <p data-testid="calibration" />;
  },
}));

// Three per CompactLayout render, so it counts the compact layout.
vi.mock("../sections/compact/ModeButton", () => ({
  ModeButton: ({ kind, disabled }: { kind: string; disabled: boolean }) => {
    count("compactModeButton");
    return <button type="button" data-testid={`mode-button-${kind}`} disabled={disabled} />;
  },
}));

vi.mock("../sections/control/LightingSmoothingPresetControl", () => ({
  LightingSmoothingPresetControl: () => null,
}));

import { SettingsLayout } from "../SettingsLayout";

const TESTID: Record<Exclude<SectionId, "lights">, string> = {
  [SECTION_IDS.SYSTEM]: "system-checking",
  [SECTION_IDS.DEVICES]: "devices-category",
  [SECTION_IDS.ROOM_MAP]: "room-map",
  [SECTION_IDS.LED_SETUP]: "calibration",
};

const NAME: Record<Exclude<SectionId, "lights">, string> = {
  [SECTION_IDS.SYSTEM]: "system",
  [SECTION_IDS.DEVICES]: "devices",
  [SECTION_IDS.ROOM_MAP]: "roomMap",
  [SECTION_IDS.LED_SETUP]: "calibration",
};

async function renderFull(activeSection: SectionId) {
  const shell = renderWithShellStores(<SettingsLayout />, {
    navigation: { uiMode: "full", activeSection },
    lighting: { localSink: { transport: "serial", id: "/dev/cu.test" } },
  });
  // The full-only sections are lazy chunks; wait for the section itself.
  if (activeSection !== SECTION_IDS.LIGHTS) await screen.findByTestId(TESTID[activeSection]);
  return shell;
}

const DOWNLOADING = (progress: number) => ({
  state: {
    status: "downloading" as const,
    update: { version: "9.9.9", currentVersion: "1.0.0", body: null, date: null },
    progress,
    downloadedBytes: progress,
    totalBytes: 100,
    bytesPerSecond: 1,
    etaSeconds: null,
  },
  isModalOpen: true,
  checkFailedNotice: null,
});

describe("SettingsLayout render boundaries", () => {
  beforeEach(() => {
    for (const key of Object.keys(renders)) delete renders[key];
  });

  it("re-renders the Lights page for a runtime revision", async () => {
    const shell = await renderFull(SECTION_IDS.LIGHTS);
    const before = renders.lights;

    shell.setLighting({ lightingMode: { kind: "ambilight" }, isModeTransitioning: true });

    expect(screen.getByTestId("lights-mode")).toHaveTextContent("ambilight");
    expect(renders.lights).toBe(before + 1);
  });

  it.each([SECTION_IDS.SYSTEM, SECTION_IDS.DEVICES, SECTION_IDS.ROOM_MAP, SECTION_IDS.LED_SETUP] as const)(
    "does not re-render %s for a runtime revision it does not show",
    async (section) => {
      const shell = await renderFull(section);
      const before = renders[NAME[section]];

      shell.setLighting({ lightingMode: { kind: "solid" }, isModeTransitioning: true });
      shell.setLighting({ isModeTransitioning: false });

      expect(renders[NAME[section]]).toBe(before);
    },
  );

  it.each([SECTION_IDS.LIGHTS, SECTION_IDS.SYSTEM] as const)(
    "does not re-render %s for a download's progress",
    async (section) => {
      const shell = await renderFull(section);
      const name = section === SECTION_IDS.LIGHTS ? "lights" : "system";
      const before = renders[name];

      act(() => shell.updater.set(DOWNLOADING(10)));
      act(() => shell.updater.set(DOWNLOADING(20)));

      expect(renders[name]).toBe(before);
    },
  );

  it("re-renders System when a check starts, which it does show", async () => {
    const shell = await renderFull(SECTION_IDS.SYSTEM);

    act(() => shell.updater.set({ ...shell.updater.get(), state: { status: "checking" } }));

    expect(screen.getByTestId("system-checking")).toHaveTextContent("true");
  });

  it.each([SECTION_IDS.SYSTEM, SECTION_IDS.DEVICES, SECTION_IDS.ROOM_MAP] as const)(
    "does not re-render %s for a Hue status change it does not show",
    async (section) => {
      const shell = await renderFull(section);
      const before = renders[NAME[section]];

      shell.setHue({ streaming: true, reconnecting: true });

      expect(renders[NAME[section]]).toBe(before);
    },
  );

  it("re-renders the Lights page for a Hue status change, which it does show", async () => {
    const shell = await renderFull(SECTION_IDS.LIGHTS);
    const before = renders.lights;

    shell.setHue({ streaming: true });

    expect(screen.getByTestId("lights-hue-streaming")).toHaveTextContent("true");
    expect(renders.lights).toBe(before + 1);
  });

  it("re-renders the room map only for the Hue status it shows", async () => {
    const shell = await renderFull(SECTION_IDS.ROOM_MAP);
    const before = renders.roomMap;

    shell.setHue({ probeVerdict: "unreachable", reachable: false });

    expect(renders.roomMap).toBe(before + 1);
  });

  it("hands the Devices page a notice's category request, and re-renders only for it", async () => {
    const shell = await renderFull(SECTION_IDS.DEVICES);
    const before = renders.devices;

    shell.setLighting({ lightingMode: { kind: "ambilight" } });
    act(() => shell.navigation.openSection(SECTION_IDS.DEVICES, "hue"));

    expect(screen.getByTestId("devices-category")).toHaveTextContent("hue");
    expect(renders.devices).toBe(before + 1);
  });

  it("re-renders compact for the mode it shows, not for a calibration it does not", async () => {
    const shell = renderWithShellStores(<SettingsLayout />, {
      navigation: { uiMode: "compact", activeSection: SECTION_IDS.LIGHTS },
      lighting: { localSink: { transport: "serial", id: "/dev/cu.test" } },
    });
    await act(async () => {});
    const before = renders.compactModeButton;

    shell.setLighting({
      calibration: {
        templateId: "monitor-27-16-9",
        counts: { top: 1, right: 1, bottom: 1, left: 1 },
        bottomMissing: 0,
        cornerOwnership: "horizontal",
        visualPreset: "subtle",
        startAnchor: "top-start",
        direction: "cw",
        totalLeds: 4,
      },
    });
    expect(renders.compactModeButton).toBe(before);

    shell.setLighting({ isModeTransitioning: true });
    expect(renders.compactModeButton).toBe(before + 3);
    expect(screen.getByTestId("mode-button-off")).toBeDisabled();
  });
});
