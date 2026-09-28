import { afterEach, describe, expect, it, vi } from "vitest";

import type { DisplayInfo } from "@/shared/contracts/display";
import type { LedStrip } from "@/shared/contracts/strips";

const listDisplaysMock = vi.hoisted(() => vi.fn<() => Promise<DisplayInfo[]>>());
const loadMock = vi.hoisted(() => vi.fn<() => Promise<Record<string, unknown>>>());

vi.mock("../../calibrationApi", () => ({ listDisplays: () => listDisplaysMock() }));
vi.mock("@/features/persistence/shellStore", () => ({ shellStore: { load: () => loadMock() } }));

import {
  __resetLedSetupSourceForTests,
  editedStripFacts,
  peekLedSetupSource,
  readLedSetupSource,
  type LedSetupSource,
} from "../ledSetupSource";

const DISPLAY: DisplayInfo = { id: "d1", label: "Display 1", width: 1920, height: 1080, x: 0, y: 0, scaleFactor: 1, isPrimary: true };

describe("ledSetupSource", () => {
  afterEach(() => {
    __resetLedSetupSourceForTests();
    vi.clearAllMocks();
  });

  it("has nothing to open on until the first read lands, then keeps it for the session", async () => {
    listDisplaysMock.mockResolvedValue([DISPLAY]);
    loadMock.mockResolvedValue({ selectedDisplayId: "d1", selectedChipType: "sk6812-rgbw", lastWledSink: { ledCount: 150 } });

    expect(peekLedSetupSource()).toBeNull();
    const read = readLedSetupSource();
    expect(peekLedSetupSource()).toBeNull();
    await read;

    const source = peekLedSetupSource();
    expect(source?.displays).toEqual([DISPLAY]);
    expect(source?.selectedDisplayId).toBe("d1");
    expect(source && editedStripFacts(source)).toEqual({ chipType: "sk6812-rgbw", wledLedCount: 150 });
  });

  // Edited from its own page, a strip's layout reads its own chip and count, not the primary strip's.
  it("reads the chip and the WLED count of the strip being laid out", () => {
    const source: LedSetupSource = {
      displays: [DISPLAY],
      selectedDisplayId: null,
      strips: [
        { id: "a", enabled: true, transport: { kind: "serial", portName: "COM3" }, hardware: { chipType: "ws2812b-grb" } },
        { id: "b", enabled: false, transport: { kind: "wled", sink: { ip: "10.0.0.5", port: 4048, ledCount: 90, protocol: "ddp" } }, hardware: { chipType: "sk6812-rgbw" } },
      ] as unknown as LedStrip[],
    };
    expect(editedStripFacts(source)).toEqual({ chipType: "ws2812b-grb", wledLedCount: 90 });
    expect(editedStripFacts(source, "a")).toEqual({ chipType: "ws2812b-grb", wledLedCount: undefined });
    expect(editedStripFacts(source, "b")).toEqual({ chipType: "sk6812-rgbw", wledLedCount: 90 });
    expect(editedStripFacts(source, "gone")).toEqual({ chipType: null, wledLedCount: undefined });
  });

  it("shares one read between visits that overlap, and reads again once it has landed", async () => {
    listDisplaysMock.mockResolvedValue([DISPLAY]);
    loadMock.mockResolvedValue({});

    const first = readLedSetupSource();
    const second = readLedSetupSource();
    expect(second).toBe(first);
    await first;
    expect(listDisplaysMock).toHaveBeenCalledTimes(1);

    await readLedSetupSource();
    expect(listDisplaysMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good answer when a later read fails", async () => {
    listDisplaysMock.mockResolvedValueOnce([DISPLAY]);
    loadMock.mockResolvedValue({});
    await readLedSetupSource();

    listDisplaysMock.mockRejectedValueOnce(new Error("display list unavailable"));
    await expect(readLedSetupSource()).rejects.toThrow("display list unavailable");
    expect(peekLedSetupSource()?.displays).toEqual([DISPLAY]);
  });
});
