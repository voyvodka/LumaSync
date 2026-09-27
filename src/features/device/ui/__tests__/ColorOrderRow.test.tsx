import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LED_TEST_STATUS,
  type LedTestPatternResult,
  type StartLedTestPatternPayload,
} from "@/shared/contracts/preview";
import type { LedColorOrder } from "@/shared/contracts/device";

import { ColorOrderRow } from "../StripHardwareRows";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      let value = key;
      for (const [k, v] of Object.entries(opts ?? {})) value = value.replace(`{{${k}}}`, String(v));
      return opts && Object.keys(opts).length > 0 ? `${key}|${JSON.stringify(opts)}` : value;
    },
  }),
}));

const calls: string[] = [];
const mockSave = vi.fn(async (hardware: Record<string, unknown>) => {
  calls.push(`save:${String(hardware.colorOrder)}`);
});

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    // A write lands on the strip the row belongs to; the assertions read that strip's hardware.
    update: async (fn: (current: Record<string, unknown>) => Record<string, unknown> | null) => {
      const partial = fn({ ledStrips: [{ id: "strip-1", enabled: true, transport: null, hardware: {} }] }) ?? {};
      const strips = partial.ledStrips as { hardware: Record<string, unknown> }[] | undefined;
      await mockSave(strips?.[0]?.hardware ?? {});
      return partial;
    },
  },
}));

const STARTED: LedTestPatternResult = {
  active: true,
  previewOnly: false,
  status: { code: LED_TEST_STATUS.PATTERN_STARTED, message: "", details: null },
};
const STOPPED: LedTestPatternResult = {
  active: false,
  previewOnly: false,
  status: { code: LED_TEST_STATUS.PATTERN_STOPPED, message: "", details: null },
};

const start = vi.fn(async (payload: StartLedTestPatternPayload) => {
  calls.push(`start:${payload.pattern.kind === "channelProbe" ? payload.pattern.slot : "?"}`);
  return STARTED;
});
const stop = vi.fn(async () => {
  calls.push("stop");
  return STOPPED;
});
const onColorOrderChange = vi.fn((next: LedColorOrder) => {
  calls.push(`apply:${next}`);
});

// Derived from a real key: the i18n gate reads every quoted "ns:path" as a key reference.
const K = "lights:led.colorOrder.identify.button".replace(/\.button$/, "");
const IDENTIFY = "device:strip.action.identify";

function renderControl({ order = "rgb" as LedColorOrder, canIdentify = true } = {}) {
  return render(
    <ColorOrderRow
      stripId="strip-1"
      order={order}
      canIdentify={canIdentify}
      onChange={onColorOrderChange}
      identifyDeps={{ start, stop }}
    />,
  );
}

async function pick(color: "red" | "green" | "blue" | "other") {
  const button = await screen.findByRole("button", { name: new RegExp(`${K}.answer.${color}$`) });
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
}

async function beginIdentify() {
  fireEvent.click(await screen.findByRole("button", { name: IDENTIFY }));
}

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe("ColorOrderRow identify flow", () => {
  it("saves the literal answers, stops the probe, then retunes — in that order", async () => {
    renderControl();
    await beginIdentify();
    await pick("green");
    await pick("red");
    await pick("blue");

    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${K}.apply`) }));

    await waitFor(() => expect(onColorOrderChange).toHaveBeenCalledWith("grb"));
    expect(mockSave).toHaveBeenCalledWith({ colorOrder: "grb" });
    expect(calls).toEqual(["start:0", "start:1", "start:2", "save:grb", "stop", "apply:grb"]);
    expect(start.mock.calls.map(([p]) => p.targets)).toEqual([["usb"], ["usb"], ["usb"]]);
    expect(await screen.findByText(new RegExp(`^${K}.verify\\|`))).toBeInTheDocument();
  });

  it("never retunes while the probe may still be lit", async () => {
    let releaseStop: (value: LedTestPatternResult) => void = () => {};
    stop.mockImplementationOnce(
      () =>
        new Promise<LedTestPatternResult>((resolve) => {
          calls.push("stop");
          releaseStop = resolve;
        }),
    );
    renderControl();
    await beginIdentify();
    await pick("green");
    await pick("red");
    await pick("blue");
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${K}.apply`) }));

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(onColorOrderChange).not.toHaveBeenCalled();

    await act(async () => releaseStop(STOPPED));
    await waitFor(() => expect(onColorOrderChange).toHaveBeenCalledWith("grb"));
  });

  it("rejects a colour already given for an earlier slot", async () => {
    renderControl();
    await beginIdentify();
    await pick("red");
    await pick("red");

    expect(await screen.findByRole("alert")).toHaveTextContent(`${K}.duplicate`);
    expect(calls).toEqual(["start:0", "start:1"]);
    expect(screen.getByText(new RegExp(`${K}.step\\|.*"current":2`))).toBeInTheDocument();
  });

  it("cancel mid-flow stops the probe and saves nothing", async () => {
    renderControl();
    await beginIdentify();
    await pick("green");
    await screen.findByText(new RegExp(`${K}.step\\|.*"current":2`));

    // The button that opened it closes it again, which cancels.
    fireEvent.click(screen.getByRole("button", { name: IDENTIFY }));

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(mockSave).not.toHaveBeenCalled();
    expect(onColorOrderChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: IDENTIFY })).not.toBeDisabled());
  });

  it("'something else' stops the probe and points at chip type and firmware", async () => {
    renderControl();
    await beginIdentify();
    await pick("other");

    expect(await screen.findByRole("alert")).toHaveTextContent(`${K}.otherHint`);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("sends no stop when the probe never started — a bare stop turns the lights off", async () => {
    start.mockResolvedValueOnce({
      active: false,
      previewOnly: false,
      status: { code: LED_TEST_STATUS.PATTERN_NO_CALIBRATION, message: "", details: null },
    });
    renderControl();
    await beginIdentify();

    expect(await screen.findByRole("alert")).toHaveTextContent(`${K}.errors.noCalibration`);
    expect(stop).not.toHaveBeenCalled();
  });

  it("undo in the verify step puts the previous order back", async () => {
    renderControl({ order: "bgr" });
    await screen.findByLabelText(/currentAria\|.*"order":"BGR"/);
    await beginIdentify();
    await pick("green");
    await pick("red");
    await pick("blue");
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${K}.apply`) }));

    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${K}.undo`) }));

    await waitFor(() => expect(onColorOrderChange).toHaveBeenLastCalledWith("bgr"));
    expect(mockSave).toHaveBeenLastCalledWith({ colorOrder: "bgr" });
    // Undo runs with no probe lit, so it sends no second stop.
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("ColorOrderRow surface", () => {
  it("shows the saved order as an uppercase code", () => {
    renderControl({ order: "grb" });
    expect(screen.getByTestId("strip-color-order-value")).toHaveTextContent("GRB");
  });

  it("cannot identify without a connected strip to light", () => {
    renderControl({ canIdentify: false });
    expect(screen.getByRole("button", { name: IDENTIFY })).toBeDisabled();
  });

  it("the list saves before it retunes", async () => {
    renderControl();
    fireEvent.click(screen.getByTestId("strip-color-order-value"));
    fireEvent.click(await screen.findByRole("option", { name: "BGR" }));
    await waitFor(() => expect(onColorOrderChange).toHaveBeenCalledWith("bgr"));
    expect(calls).toEqual(["save:bgr", "apply:bgr"]);
  });
});
