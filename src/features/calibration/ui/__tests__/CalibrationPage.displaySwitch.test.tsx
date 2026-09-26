// While the calibration overlay moves between displays, LED Setup's monitor
// picker and its test-pattern button hold still (#244). The store marked the
// switch from the start, but only the settled snapshot ever reached React —
// by then the flag was already cleared — so neither control ever held still:
// a monitor picked mid-open was saved as the capture source while the overlay
// landed on the other screen, and a second press started a second test. The
// start itself (seconds on Hue) held nothing, so a press after the overlay had
// landed but before the start answered started a second test too.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as modeApiModule from "@/features/mode/modeApi";
import type { shellStore as shellStoreType } from "@/features/persistence/shellStore";
import {
  DISPLAY_OVERLAY_STATUS,
  type DisplayInfo,
  type DisplayOverlayCommandResult,
} from "@/shared/contracts/display";
import { LED_TEST_STATUS } from "@/shared/contracts/preview";
import { invokeFromCommands } from "@/test/mockCommands";

import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import { CalibrationPage } from "../CalibrationPage";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn<typeof invoke>(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setFocus: () => Promise.resolve() }),
}));

const saveMock = vi.fn<typeof shellStoreType.save>();
vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve({}),
    save: (partial: Parameters<typeof shellStoreType.save>[0]) => saveMock(partial),
  },
}));

vi.mock("@/features/mode/modeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/mode/modeApi")>()),
  acquireHueForTest: vi.fn<typeof modeApiModule.acquireHueForTest>(),
  releaseHueAfterTest: vi.fn<typeof modeApiModule.releaseHueAfterTest>(),
}));

const DISPLAYS: DisplayInfo[] = [
  { id: "display-1", label: "Display 1", width: 1920, height: 1080, x: 0, y: 0, scaleFactor: 1, isPrimary: true },
  { id: "display-2", label: "Display 2", width: 2560, height: 1440, x: 1920, y: 0, scaleFactor: 1, isPrimary: false },
];

const SAVED: LedCalibrationConfig = {
  counts: { top: 40, right: 20, bottom: 40, left: 20 },
  bottomMissing: 0,
  cornerOwnership: "horizontal",
  visualPreset: "vivid",
  startAnchor: "left-start",
  direction: "cw",
  totalLeds: 120,
};

const OVERLAY_OPENED: DisplayOverlayCommandResult = {
  ok: true,
  code: DISPLAY_OVERLAY_STATUS.OPENED,
  message: "",
};

/** Displays the overlay was asked to open on, in order. */
let openedOn: string[] = [];
let startCount = 0;
/** Settles every overlay open still waiting. */
let finishOpening: () => void = () => {};
/** When set, `start_led_test_pattern` waits for `finishStarting`. */
let holdStart = false;
let finishStarting: () => void = () => {};

beforeEach(() => {
  openedOn = [];
  startCount = 0;
  holdStart = false;
  const pending: Array<() => void> = [];
  finishOpening = () => {
    for (const settle of pending.splice(0)) settle();
  };
  const pendingStarts: Array<() => void> = [];
  finishStarting = () => {
    for (const settle of pendingStarts.splice(0)) settle();
  };
  saveMock.mockReset().mockResolvedValue(undefined);
  vi.mocked(invoke).mockImplementation(
    invokeFromCommands({
      list_displays: DISPLAYS,
      open_display_overlay: ({ displayId }) => {
        openedOn.push(displayId);
        return new Promise<DisplayOverlayCommandResult>((resolve) => {
          pending.push(() => resolve(OVERLAY_OPENED));
        });
      },
      close_display_overlay: { ...OVERLAY_OPENED, code: DISPLAY_OVERLAY_STATUS.CLOSED },
      update_display_overlay_preview: { ...OVERLAY_OPENED, code: DISPLAY_OVERLAY_STATUS.PREVIEW_SYNCED },
      start_led_test_pattern: () => {
        startCount += 1;
        const started = {
          active: true,
          previewOnly: true,
          status: { code: LED_TEST_STATUS.PATTERN_PREVIEW_ONLY, message: "", details: null },
        };
        if (!holdStart) return started;
        return new Promise<typeof started>((resolve) => {
          pendingStarts.push(() => resolve(started));
        });
      },
      stop_led_test_pattern: {
        active: false,
        previewOnly: false,
        status: { code: LED_TEST_STATUS.PATTERN_STOPPED, message: "", details: null },
      },
    }),
  );
});

function monitorMenu(): HTMLElement {
  return screen.getByRole("button", { name: "calibration:setup.displayLabel" });
}

async function pickMonitor(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(monitorMenu());
  await user.click(screen.getByRole("option", { name: new RegExp(label) }));
  // A pick is handed over once its tint lands, and the list then settles out.
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

function runButton(): HTMLElement {
  return screen.getByRole("button", { name: "calibration:setup.test" });
}

/** Renders the page with both monitors listed and starts the test pattern,
 * leaving the overlay open in flight. */
async function startTestWithOverlayOpening() {
  const user = userEvent.setup();
  render(<CalibrationPage initialConfig={SAVED} onNavigateBack={() => {}} onSaved={() => {}} />);
  await screen.findByText("Display 1");
  await user.click(runButton());
  await waitFor(() => expect(openedOn).toEqual(["display-1"]));
  return user;
}

describe("CalibrationPage — while the overlay switches display", () => {
  it("marks the monitor picker and the test button busy, and clears it once the overlay lands", async () => {
    await startTestWithOverlayOpening();

    expect(monitorMenu()).toHaveAttribute("aria-busy", "true");
    expect(runButton()).toHaveAttribute("aria-disabled", "true");

    await act(async () => finishOpening());

    await waitFor(() => expect(monitorMenu()).not.toHaveAttribute("aria-busy"));
  });

  it("keeps the busy controls focusable, so a keyboard user is not dropped to the page", async () => {
    await startTestWithOverlayOpening();

    // A natively disabled button loses focus the moment it is disabled.
    expect(monitorMenu()).not.toBeDisabled();
    expect(runButton()).not.toBeDisabled();
  });

  it("does not save a monitor picked mid-switch over the one the overlay lands on", async () => {
    const user = await startTestWithOverlayOpening();

    await pickMonitor(user, "Display 2");
    await act(async () => finishOpening());

    await waitFor(() => expect(screen.getByRole("button", { name: "calibration:setup.stop" })).toBeInTheDocument());
    expect(saveMock).not.toHaveBeenCalledWith({ selectedDisplayId: "display-2" });
    expect(openedOn).toEqual(["display-1"]);
  });

  it("starts one test pattern, not two, when the button is pressed again mid-switch", async () => {
    const user = await startTestWithOverlayOpening();

    await user.click(runButton());
    await act(async () => finishOpening());

    await waitFor(() => expect(screen.getByRole("button", { name: "calibration:setup.stop" })).toBeInTheDocument());
    // Let a second toggle, had one been queued, reach the backend.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(startCount).toBe(1);
  });
});

describe("CalibrationPage — while the test pattern starts", () => {
  it("starts one test pattern, not two, when the button is pressed again after the overlay landed", async () => {
    holdStart = true;
    const user = await startTestWithOverlayOpening();
    await act(async () => finishOpening());
    await waitFor(() => expect(startCount).toBe(1));

    await user.click(runButton());
    // Had the press begun a second run, its overlay open would be waiting here.
    await act(async () => finishOpening());
    await act(async () => finishStarting());
    await act(async () => finishOpening());
    await act(async () => finishStarting());

    await waitFor(() => expect(screen.getByRole("button", { name: "calibration:setup.stop" })).toBeInTheDocument());
    expect(startCount).toBe(1);
    expect(openedOn).toEqual(["display-1"]);
  });

  it("marks the test button busy until the start answers", async () => {
    holdStart = true;
    await startTestWithOverlayOpening();
    await act(async () => finishOpening());
    await waitFor(() => expect(startCount).toBe(1));

    expect(runButton()).toHaveAttribute("aria-disabled", "true");
    expect(runButton()).not.toBeDisabled();

    await act(async () => finishStarting());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "calibration:setup.stop" })).not.toHaveAttribute("aria-disabled"),
    );
  });
});

describe("CalibrationPage — the monitor picker", () => {
  it("is a listbox whose selected option is the selected monitor, and a pick is saved once it lands", async () => {
    const user = userEvent.setup();
    render(<CalibrationPage initialConfig={SAVED} onNavigateBack={() => {}} onSaved={() => {}} />);
    await screen.findByText("Display 1");

    await user.click(monitorMenu());
    expect(screen.getByRole("listbox", { name: "calibration:setup.displayLabel" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Display 1/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /Display 2/ })).toHaveAttribute("aria-selected", "false");

    await user.click(screen.getByRole("option", { name: /Display 2/ }));

    // The tint lands on the pick first, then it is handed over and the list settles out.
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ selectedDisplayId: "display-2" }));
    expect(monitorMenu()).toHaveTextContent("Display 2");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });
});
