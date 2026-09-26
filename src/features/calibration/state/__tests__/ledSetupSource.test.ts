import { afterEach, describe, expect, it, vi } from "vitest";

import type { DisplayInfo } from "@/shared/contracts/display";

const listDisplaysMock = vi.hoisted(() => vi.fn<() => Promise<DisplayInfo[]>>());
const loadMock = vi.hoisted(() => vi.fn<() => Promise<Record<string, unknown>>>());

vi.mock("../../calibrationApi", () => ({ listDisplays: () => listDisplaysMock() }));
vi.mock("@/features/persistence/shellStore", () => ({ shellStore: { load: () => loadMock() } }));

import { __resetLedSetupSourceForTests, peekLedSetupSource, readLedSetupSource } from "../ledSetupSource";

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

    expect(peekLedSetupSource()).toEqual({
      displays: [DISPLAY],
      selectedDisplayId: "d1",
      chipType: "sk6812-rgbw",
      wledLedCount: 150,
    });
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
