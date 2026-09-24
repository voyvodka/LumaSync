// While the calibration overlay moves between displays, LED Setup's monitor
// picker and its test-pattern button hold still (#244). The store marked the
// switch from the start, but only the settled snapshot ever reached React —
// by then the flag was already cleared — so neither control ever held still:
// a monitor picked mid-open was saved as the capture source while the overlay
// landed on the other screen, and a second press started a second test.

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

beforeEach(() => {
  openedOn = [];
  startCount = 0;
  const pending: Array<() => void> = [];
  finishOpening = () => {
    for (const settle of pending.splice(0)) settle();
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
        return {
          active: true,
          previewOnly: true,
          status: { code: LED_TEST_STATUS.PATTERN_PREVIEW_ONLY, message: "", details: null },
        };
      },
      stop_led_test_pattern: {
        active: false,
        previewOnly: false,
        status: { code: LED_TEST_STATUS.PATTERN_STOPPED, message: "", details: null },
      },
    }),
  );
});

function monitorButton(label: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(label) });
}

function runButton(): HTMLElement {
  return screen.getByRole("button", { name: "calibration:page.runTestPattern" });
}

/** Renders the page with both monitors listed and starts the test pattern,
 * leaving the overlay open in flight. */
async function startTestWithOverlayOpening() {
  const user = userEvent.setup();
  render(<CalibrationPage onNavigateBack={() => {}} onSaved={() => {}} />);
  await screen.findByText("Display 2");
  await user.click(runButton());
  await waitFor(() => expect(openedOn).toEqual(["display-1"]));
  return user;
}

describe("CalibrationPage — while the overlay switches display", () => {
  it("marks the monitor picker and the test button busy, and clears it once the overlay lands", async () => {
    await startTestWithOverlayOpening();

    expect(monitorButton("Display 1")).toHaveAttribute("aria-disabled", "true");
    expect(monitorButton("Display 2")).toHaveAttribute("aria-disabled", "true");
    expect(runButton()).toHaveAttribute("aria-disabled", "true");

    await act(async () => finishOpening());

    await waitFor(() => expect(monitorButton("Display 2")).not.toHaveAttribute("aria-disabled"));
    expect(monitorButton("Display 1")).not.toHaveAttribute("aria-disabled");
  });

  it("keeps the busy controls focusable, so a keyboard user is not dropped to the page", async () => {
    await startTestWithOverlayOpening();

    // A natively disabled button loses focus the moment it is disabled.
    expect(monitorButton("Display 2")).not.toBeDisabled();
    expect(runButton()).not.toBeDisabled();
  });

  it("does not save a monitor picked mid-switch over the one the overlay lands on", async () => {
    const user = await startTestWithOverlayOpening();

    await user.click(monitorButton("Display 2"));
    await act(async () => finishOpening());

    await waitFor(() => expect(screen.getByRole("button", { name: "calibration:page.stopTestPattern" })).toBeInTheDocument());
    expect(saveMock).not.toHaveBeenCalledWith({ selectedDisplayId: "display-2" });
    expect(openedOn).toEqual(["display-1"]);
  });

  it("starts one test pattern, not two, when the button is pressed again mid-switch", async () => {
    const user = await startTestWithOverlayOpening();

    await user.click(runButton());
    await act(async () => finishOpening());

    await waitFor(() => expect(screen.getByRole("button", { name: "calibration:page.stopTestPattern" })).toBeInTheDocument());
    // Let a second toggle, had one been queued, reach the backend.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(startCount).toBe(1);
  });
});
