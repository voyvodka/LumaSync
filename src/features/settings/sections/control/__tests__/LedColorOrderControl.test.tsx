import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LED_TEST_STATUS,
  type LedTestPatternResult,
  type StartLedTestPatternPayload,
} from "@/shared/contracts/preview";
import { LedColorOrderControl } from "../LedColorOrderControl";

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
const mockState: { ledColorOrder?: string } = {};
const mockSave = vi.fn(async (partial: Record<string, unknown>) => {
  calls.push(`save:${String(partial.ledColorOrder)}`);
});

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: vi.fn(async () => ({ ...mockState })),
    save: (partial: Record<string, unknown>) => mockSave(partial),
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
const onColorOrderChange = vi.fn((next: string) => {
  calls.push(`apply:${next}`);
});

// Derived from a real key: the i18n gate reads every quoted "ns:path" as a key reference.
const K = "lights:led.colorOrder.identify.button".replace(/\.button$/, "");

function renderControl(localTransport: "serial" | "wled" | null = "serial") {
  return render(
    <LedColorOrderControl
      localTransport={localTransport}
      onColorOrderChange={onColorOrderChange}
      start={start}
      stop={stop}
    />,
  );
}

async function pick(color: "red" | "green" | "blue" | "other") {
  const button = await screen.findByRole("button", { name: new RegExp(`${K}.answer.${color}$`) });
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
}

async function beginIdentify() {
  const button = await screen.findByRole("button", { name: `${K}.button` });
  fireEvent.click(button);
}

beforeEach(() => {
  calls.length = 0;
  delete mockState.ledColorOrder;
  vi.clearAllMocks();
});

describe("LedColorOrderControl identify flow", () => {
  it("saves the literal answers, stops the probe, then retunes — in that order", async () => {
    renderControl();
    await beginIdentify();
    await pick("green");
    await pick("red");
    await pick("blue");

    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${K}.apply`) }));

    await waitFor(() => expect(onColorOrderChange).toHaveBeenCalledWith("grb"));
    expect(mockSave).toHaveBeenCalledWith({ ledColorOrder: "grb" });
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

    fireEvent.click(screen.getByRole("button", { name: `${K}.cancel` }));

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(mockSave).not.toHaveBeenCalled();
    expect(onColorOrderChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: `${K}.button` })).not.toBeDisabled();
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
    mockState.ledColorOrder = "bgr";
    renderControl();
    await screen.findByLabelText(/currentAria\|.*"order":"BGR"/);
    await beginIdentify();
    await pick("green");
    await pick("red");
    await pick("blue");
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${K}.apply`) }));

    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${K}.undo`) }));

    await waitFor(() => expect(onColorOrderChange).toHaveBeenLastCalledWith("bgr"));
    expect(mockSave).toHaveBeenLastCalledWith({ ledColorOrder: "bgr" });
    // Undo runs with no probe lit, so it sends no second stop.
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("LedColorOrderControl surface", () => {
  it("shows the saved order as an uppercase code, tagged when it is the default", async () => {
    renderControl();
    expect(await screen.findByLabelText(/currentAria\|.*"order":"RGB"/)).toHaveTextContent(/^RGB$/);
    expect(screen.getByText("lights:led.colorOrder.defaultTag")).toBeInTheDocument();
  });

  it("hides the control for a WLED output and says where to set it", async () => {
    renderControl("wled");
    expect(await screen.findByText("lights:led.colorOrder.wledHint")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `${K}.button` })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("disables Identify with a reason when no strip is connected", async () => {
    renderControl(null);
    const button = await screen.findByRole("button", { name: `${K}.button` });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(`${K}.needsStrip`);
  });

  it("the manual selector saves before it retunes", async () => {
    renderControl();
    await screen.findByLabelText(/currentAria\|.*"order":"RGB"/);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "brg" } });

    await waitFor(() => expect(onColorOrderChange).toHaveBeenCalledWith("brg"));
    expect(calls).toEqual(["save:brg", "apply:brg"]);
    expect(start).not.toHaveBeenCalled();
  });
});
