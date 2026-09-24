import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import { LED_TEST_STATUS, type LedTestPatternResult } from "@/shared/contracts/preview";

import {
  createDefaultTestPatternFlow,
  createTestPatternFlow,
  isTestPatternFailure,
} from "../testPatternFlow";
import type * as previewApiModule from "@/features/preview/previewApi";
import type * as modeApiModule from "@/features/mode/modeApi";

vi.mock("@/features/preview/previewApi", () => ({
  startLedTestPattern: vi.fn<typeof previewApiModule.startLedTestPattern>(),
  stopLedTestPattern: vi.fn<typeof previewApiModule.stopLedTestPattern>(),
}));

let storeState: Record<string, unknown> = {};

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: () => Promise.resolve(storeState) },
}));

vi.mock("@/features/mode/modeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/mode/modeApi")>()),
  acquireHueForTest: vi.fn<typeof modeApiModule.acquireHueForTest>().mockResolvedValue(undefined),
  releaseHueAfterTest: vi.fn<typeof modeApiModule.releaseHueAfterTest>().mockResolvedValue(undefined),
}));

const previewApi = await import("@/features/preview/previewApi");
const startLedTestPatternMock = vi.mocked(previewApi.startLedTestPattern);
const stopLedTestPatternMock = vi.mocked(previewApi.stopLedTestPattern);
const hueTestLease = await import("@/features/mode/modeApi");
const acquireHueForTestMock = vi.mocked(hueTestLease.acquireHueForTest);
const releaseHueAfterTestMock = vi.mocked(hueTestLease.releaseHueAfterTest);

const BASE_COUNTS = { top: 4, right: 3, bottom: 4, left: 3 } as const;

function createConfig(overrides?: Partial<LedCalibrationConfig>): LedCalibrationConfig {
  return {
    counts: { ...BASE_COUNTS },
    bottomMissing: 0,
    cornerOwnership: "horizontal",
    visualPreset: "vivid",
    startAnchor: "left-end",
    direction: "cw",
    totalLeds: BASE_COUNTS.top + BASE_COUNTS.right + BASE_COUNTS.bottom + BASE_COUNTS.left,
    ...overrides,
  };
}

function result(overrides?: Partial<LedTestPatternResult>): LedTestPatternResult {
  return {
    active: true,
    previewOnly: false,
    status: { code: LED_TEST_STATUS.PATTERN_STARTED, message: "started", details: null },
    ...overrides,
  };
}

describe("createTestPatternFlow", () => {
  it("reports sending when the backend confirms a sink received the pattern", async () => {
    const flow = createTestPatternFlow({
      startPattern: vi.fn(async () => result()),
      stopPattern: vi.fn(async () => result({ active: false })),
    });

    const snapshot = await flow.toggle(true);

    expect(snapshot.isEnabled).toBe(true);
    expect(snapshot.mode).toBe("sending");
    expect(snapshot.lastStatus).toBe(LED_TEST_STATUS.PATTERN_STARTED);
  });

  it("reports preview-only from the backend verdict rather than a local guess", async () => {
    const flow = createTestPatternFlow({
      startPattern: vi.fn(async () =>
        result({
          previewOnly: true,
          status: { code: LED_TEST_STATUS.PATTERN_PREVIEW_ONLY, message: "no sink", details: null },
        }),
      ),
      stopPattern: vi.fn(async () => result({ active: false })),
    });

    const snapshot = await flow.toggle(true);

    expect(snapshot.isEnabled).toBe(true);
    expect(snapshot.mode).toBe("preview-only");
  });

  // The defect this whole path was rewritten for: the old flow set
  // `isEnabled` before asking anything, so a start that never happened still
  // lit an "Output active" badge.
  it("stays disabled when the backend refuses to start", async () => {
    const flow = createTestPatternFlow({
      startPattern: vi.fn(async () =>
        result({
          active: false,
          status: { code: LED_TEST_STATUS.PATTERN_NO_CALIBRATION, message: "no calibration", details: null },
        }),
      ),
      stopPattern: vi.fn(async () => result({ active: false })),
    });

    const snapshot = await flow.toggle(true);

    expect(snapshot.isEnabled).toBe(false);
    expect(snapshot.lastStatus).toBe(LED_TEST_STATUS.PATTERN_NO_CALIBRATION);
  });

  it("stops the backend pattern on dispose only while one is running", async () => {
    const stopPattern = vi.fn(async () => result({ active: false }));
    const flow = createTestPatternFlow({
      startPattern: vi.fn(async () => result()),
      stopPattern,
    });

    await flow.dispose();
    expect(stopPattern).not.toHaveBeenCalled();

    await flow.toggle(true);
    await flow.dispose();
    expect(stopPattern).toHaveBeenCalledTimes(1);
    expect(flow.getSnapshot().isEnabled).toBe(false);
  });
});

describe("isTestPatternFailure", () => {
  it("separates a refusal from a preview-only run", () => {
    expect(isTestPatternFailure(LED_TEST_STATUS.PATTERN_NO_CALIBRATION)).toBe(true);
    expect(isTestPatternFailure(LED_TEST_STATUS.PATTERN_RUNTIME_ERROR)).toBe(true);
    expect(isTestPatternFailure(LED_TEST_STATUS.PATTERN_INVALID_PARAMS)).toBe(true);
    expect(isTestPatternFailure(LED_TEST_STATUS.PATTERN_PREVIEW_ONLY)).toBe(false);
    expect(isTestPatternFailure(LED_TEST_STATUS.PATTERN_STARTED)).toBe(false);
    expect(isTestPatternFailure(null)).toBe(false);
  });
});

describe("createDefaultTestPatternFlow", () => {
  beforeEach(() => {
    storeState = {};
    startLedTestPatternMock.mockClear();
    acquireHueForTestMock.mockClear();
    releaseHueAfterTestMock.mockClear();
  });

  it("sends the edited layout, not the last saved one", async () => {
    startLedTestPatternMock.mockResolvedValue(result());
    stopLedTestPatternMock.mockResolvedValue(result({ active: false }));

    const saved = createConfig();
    const flow = createDefaultTestPatternFlow(saved);
    const edited = createConfig({ counts: { top: 9, right: 9, bottom: 9, left: 9 }, totalLeds: 36 });
    flow.setConfig(edited);

    await flow.toggle(true);

    const payload = startLedTestPatternMock.mock.calls[0][0];
    expect(payload.ledCalibration).toEqual(edited);
    expect(payload.pattern.kind).toBe("chase");
  });

  it("tests the outputs the user last lit, not a hardcoded USB strip", async () => {
    storeState = { lastOutputTargets: ["hue"] };
    startLedTestPatternMock.mockResolvedValue(result());

    await createDefaultTestPatternFlow(createConfig()).toggle(true);

    expect(startLedTestPatternMock.mock.calls[0][0].targets).toEqual(["hue"]);
    expect(acquireHueForTestMock).toHaveBeenCalledWith(["hue"]);
  });

  it("falls back to USB when nothing has been lit yet", async () => {
    startLedTestPatternMock.mockResolvedValue(result());

    await createDefaultTestPatternFlow(createConfig()).toggle(true);

    expect(startLedTestPatternMock.mock.calls[0][0].targets).toEqual(["usb"]);
  });

  it("hands the stream back when the start is refused, since no stop will follow", async () => {
    storeState = { lastOutputTargets: ["hue"] };
    startLedTestPatternMock.mockResolvedValue(
      result({ active: false, status: { code: LED_TEST_STATUS.PATTERN_NO_CALIBRATION, message: "", details: null } }),
    );

    await createDefaultTestPatternFlow(createConfig()).toggle(true);

    expect(releaseHueAfterTestMock).toHaveBeenCalledTimes(1);
  });

  it("hands the stream back when the test is switched off", async () => {
    storeState = { lastOutputTargets: ["hue"] };
    startLedTestPatternMock.mockResolvedValue(result());
    stopLedTestPatternMock.mockResolvedValue(result({ active: false }));

    const flow = createDefaultTestPatternFlow(createConfig());
    await flow.toggle(true);
    expect(releaseHueAfterTestMock).not.toHaveBeenCalled();

    await flow.toggle(false);
    expect(releaseHueAfterTestMock).toHaveBeenCalledTimes(1);
  });
});

describe("createTestPatternFlow — the layout a running test shows", () => {
  it("records the layout the test started with, and none after a refusal", async () => {
    const flow = createTestPatternFlow({
      startPattern: vi.fn<() => Promise<LedTestPatternResult>>(async () => result()),
      stopPattern: vi.fn<() => Promise<LedTestPatternResult>>(async () => result({ active: false })),
    });
    const started = createConfig();
    flow.setConfig(started);
    expect((await flow.toggle(true)).layout).toEqual(started);

    flow.setConfig(createConfig({ direction: "ccw" }));
    // An edit alone does not reach the strip; only a (re)start does.
    expect(flow.getSnapshot().layout).toEqual(started);
    expect((await flow.toggle(false)).layout).toBeNull();
  });

  it("restarts a running test with the current layout", async () => {
    const startPattern = vi.fn<() => Promise<LedTestPatternResult>>(async () => result());
    const flow = createTestPatternFlow({
      startPattern,
      stopPattern: vi.fn<() => Promise<LedTestPatternResult>>(async () => result({ active: false })),
    });
    flow.setConfig(createConfig());
    await flow.toggle(true);
    const edited = createConfig({ direction: "ccw" });
    flow.setConfig(edited);

    const next = await flow.retune();

    expect(startPattern).toHaveBeenCalledTimes(2);
    expect(next.isEnabled).toBe(true);
    expect(next.layout).toEqual(edited);
  });

  it("does nothing while no test runs", async () => {
    const startPattern = vi.fn<() => Promise<LedTestPatternResult>>(async () => result());
    const flow = createTestPatternFlow({ startPattern, stopPattern: vi.fn<() => Promise<LedTestPatternResult>>(async () => result()) });
    await flow.retune();
    expect(startPattern).not.toHaveBeenCalled();
  });

  // An early refusal leaves the old run going in Rust; left alone it would keep
  // driving a layout the page no longer shows, with no Stop button to end it.
  it("stops the test when the restart is refused", async () => {
    const stopPattern = vi.fn<() => Promise<LedTestPatternResult>>(async () => result({ active: false }));
    const startPattern = vi
      .fn<() => Promise<LedTestPatternResult>>()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(
        result({ active: false, status: { code: LED_TEST_STATUS.PATTERN_INVALID_PARAMS, message: "", details: null } }),
      );
    const flow = createTestPatternFlow({ startPattern, stopPattern });
    flow.setConfig(createConfig());
    await flow.toggle(true);

    const next = await flow.retune();

    expect(stopPattern).toHaveBeenCalledTimes(1);
    expect(next.isEnabled).toBe(false);
    expect(next.lastStatus).toBe(LED_TEST_STATUS.PATTERN_INVALID_PARAMS);
  });
});
