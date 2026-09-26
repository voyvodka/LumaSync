// LED Setup asks for the strip's total before anything else when there is no
// saved layout, and splits it over the edges by the display's shape. The old
// first fill guessed counts from the display's pixel width, so a 3600-px
// laptop panel got 164 LEDs whatever strip was on it. The numbers sit on the
// canvas edges and read top, right, left, bottom.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type * as modeApiModule from "@/features/mode/modeApi";
import type { shellStore as shellStoreType } from "@/features/persistence/shellStore";
import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import type { ShellState } from "@/shared/contracts/shell";
import {
  DISPLAY_OVERLAY_STATUS,
  type DisplayInfo,
  type DisplayOverlayCommandResult,
} from "@/shared/contracts/display";
import { WLED_PROTOCOL } from "@/shared/contracts/device";
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

let storedShell: Partial<ShellState> = {};
const saveMock = vi.fn<typeof shellStoreType.save>();
vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => Promise.resolve(storedShell),
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
  { id: "display-2", label: "Portrait", width: 1080, height: 1920, x: 1920, y: 0, scaleFactor: 1, isPrimary: false },
];

const OVERLAY_OPENED: DisplayOverlayCommandResult = { ok: true, code: DISPLAY_OVERLAY_STATUS.OPENED, message: "" };

const SAVED: LedCalibrationConfig = {
  counts: { top: 40, right: 20, bottom: 0, left: 20 },
  bottomMissing: 0,
  cornerOwnership: "horizontal",
  visualPreset: "vivid",
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 80,
};

beforeEach(() => {
  storedShell = {};
  saveMock.mockReset().mockResolvedValue(undefined);
  vi.mocked(invoke).mockImplementation(
    invokeFromCommands({
      list_displays: DISPLAYS,
      open_display_overlay: OVERLAY_OPENED,
      close_display_overlay: { ...OVERLAY_OPENED, code: DISPLAY_OVERLAY_STATUS.CLOSED },
      update_display_overlay_preview: { ...OVERLAY_OPENED, code: DISPLAY_OVERLAY_STATUS.PREVIEW_SYNCED },
    }),
  );
});

async function renderPage(
  props: Partial<Parameters<typeof CalibrationPage>[0]> = {},
): Promise<{ onNavigateBack: Mock<() => void> }> {
  const onNavigateBack = vi.fn<() => void>();
  render(<CalibrationPage onNavigateBack={onNavigateBack} onSaved={vi.fn<(config: LedCalibrationConfig) => void>()} {...props} />);
  await screen.findByText("Display 1");
  return { onNavigateBack };
}

const question = () => screen.queryByLabelText("calibration:page.totalStep.question");
const distributeButton = () => screen.getByRole("button", { name: "calibration:setup.distribute" });
const edgeValues = () =>
  screen
    .queryAllByRole("button", { name: "calibration:page.aria.countInput" })
    .map((chip) => Number(chip.textContent));

async function changeTotal(user: ReturnType<typeof userEvent.setup>, total: string) {
  await user.click(screen.getByRole("button", { name: "calibration:setup.editTotal" }));
  const field = screen.getByRole("textbox", { name: "calibration:setup.totalField" });
  await user.clear(field);
  await user.type(field, total);
}

async function pickDisplay(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole("button", { name: "calibration:setup.displayLabel" }));
  await user.click(screen.getByRole("option", { name }));
  // A pick is handed over once its tint lands, and the list then settles out.
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

describe("LED Setup with no saved layout", () => {
  it("asks for the total first and guesses no counts from the display", async () => {
    const page = await renderPage();

    expect(question()).toHaveValue("");
    expect(edgeValues()).toHaveLength(0);
    // Nothing to save or put back yet; the dock waits for the total.
    expect(screen.queryByRole("button", { name: "calibration:overlay.save" })).toBeNull();
    expect(page.onNavigateBack).not.toHaveBeenCalled();
  });

  it("splits a typed total over the edges so they add up to it exactly", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.type(question()!, "121");
    await user.click(distributeButton());

    expect(question()).toBeNull();
    // 16:9: the odd LED goes to the top, which splits top from bottom.
    expect(edgeValues()).toEqual([39, 22, 22, 38]);
  });

  it("counts the split as the user's edit", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.type(question()!, "120{Enter}");

    expect(screen.getByRole("button", { name: "calibration:overlay.save" })).toHaveAttribute("title", "calibration:setup.unsaved");
    expect(screen.getByRole("button", { name: "calibration:setup.revert" })).toBeInTheDocument();
  });

  it("shares a new total only over the edges still lit", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.type(question()!, "120{Enter}");

    const removes = screen.getAllByRole("button", { name: "calibration:setup.remove" });
    await user.click(removes[removes.length - 1]!);
    await changeTotal(user, "120{Enter}");

    expect(edgeValues()).toEqual([56, 32, 32]);
    expect(screen.getByRole("button", { name: "calibration:setup.add.bottom" })).toBeInTheDocument();
  });

  it("refuses a total the edges cannot hold", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.type(question()!, "2");
    expect(distributeButton()).toBeDisabled();
    expect(question()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("calibration:setup.atLeast")).toBeInTheDocument();

    await user.clear(question()!);
    await user.type(question()!, "90");
    expect(distributeButton()).toBeEnabled();
  });

  it("lets the user skip to setting each edge by hand", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole("button", { name: "calibration:setup.skipTotal" }));

    expect(question()).toBeNull();
    expect(edgeValues()).toEqual([1, 1, 1, 1]);
  });
});

describe("LED Setup with a bound WLED panel", () => {
  beforeEach(() => {
    storedShell = {
      lastWledSink: { ip: "192.168.1.40", port: 4048, ledCount: 150, protocol: WLED_PROTOCOL.DDP },
    };
  });

  it("pre-fills the panel's own count without counting it as unsaved", async () => {
    await renderPage();

    await waitFor(() => expect(question()).toHaveValue("150"));
    expect(screen.getByText("calibration:page.totalStep.fromWled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "calibration:setup.revert" })).toBeNull();
  });

  it("re-splits the untouched fill for a display of another shape, and it can be saved as it stands", async () => {
    const user = userEvent.setup();
    await renderPage();
    await waitFor(() => expect(question()).toHaveValue("150"));

    await pickDisplay(user, /Portrait/);
    await user.click(distributeButton());

    // 150 over a 9:16 perimeter: the sides are the long edges now.
    expect(edgeValues()).toEqual([27, 48, 48, 27]);
    expect(screen.getByRole("button", { name: "calibration:overlay.save" })).toBeEnabled();
  });

  it("offers the panel's count when a saved total disagrees with it", async () => {
    const user = userEvent.setup();
    await renderPage({ initialConfig: SAVED });

    await user.click(screen.getByRole("button", { name: "calibration:setup.editTotal" }));
    await user.click(await screen.findByRole("button", { name: "calibration:setup.wledTotal" }));
    const field = screen.getByRole("textbox", { name: "calibration:setup.totalField" });
    expect(field).toHaveValue("150");
    await user.type(field, "{Enter}");

    expect(edgeValues()).toEqual([70, 40, 40]);
  });
});

describe("LED Setup with a saved layout", () => {
  it("opens straight on the numbers, with the unlit edge offered back", async () => {
    await renderPage({ initialConfig: SAVED });

    expect(question()).toBeNull();
    expect(edgeValues()).toEqual([40, 20, 20]);
    expect(screen.getByRole("button", { name: "calibration:setup.add.bottom" })).toBeInTheDocument();
  });

  it("re-splits a changed total over the edges the layout lights", async () => {
    const user = userEvent.setup();
    await renderPage({ initialConfig: SAVED });

    await changeTotal(user, "120{Enter}");

    expect(edgeValues()).toEqual([56, 32, 32]);
  });

  it("shares a typed total out when the field is left, without Enter", async () => {
    const user = userEvent.setup();
    await renderPage({ initialConfig: SAVED });

    await changeTotal(user, "120");
    await user.click(document.body);

    expect(edgeValues()).toEqual([56, 32, 32]);
  });

  it("steps the total with the arrow keys and applies it on leaving", async () => {
    const user = userEvent.setup();
    await renderPage({ initialConfig: SAVED });

    screen.getByRole("button", { name: "calibration:setup.editTotal" }).focus();
    await user.keyboard("{ArrowUp}");
    const field = screen.getByRole("textbox", { name: "calibration:setup.totalField" });
    expect(field).toHaveValue("81");
    await user.keyboard("{Shift>}{ArrowUp}{/Shift}{ArrowDown}");
    expect(field).toHaveValue("90");
    await user.click(document.body);

    // Top, right and left are each their own number here, so they add up to the total.
    expect(edgeValues().reduce((sum, n) => sum + n, 0)).toBe(90);
  });

  it("applies a typed total with the ✓ beside it", async () => {
    const user = userEvent.setup();
    await renderPage({ initialConfig: SAVED });

    await changeTotal(user, "120");
    await user.click(screen.getByRole("button", { name: "calibration:setup.applyTotal" }));

    expect(edgeValues()).toEqual([56, 32, 32]);
    expect(screen.queryByRole("textbox", { name: "calibration:setup.totalField" })).toBeNull();
  });

  it("leaves the counts alone when the total is closed with Esc", async () => {
    const user = userEvent.setup();
    await renderPage({ initialConfig: SAVED });

    await changeTotal(user, "120{Escape}");

    expect(screen.queryByRole("textbox", { name: "calibration:setup.totalField" })).toBeNull();
    expect(edgeValues()).toEqual([40, 20, 20]);
  });

  it("leaves counts set edge by edge alone when the same total is confirmed", async () => {
    const user = userEvent.setup();
    await renderPage({ initialConfig: { ...SAVED, counts: { top: 50, right: 10, bottom: 0, left: 20 }, totalLeds: 80 } });

    await changeTotal(user, "80{Enter}");
    expect(edgeValues()).toEqual([50, 10, 20]);

    await changeTotal(user, "80");
    await user.click(screen.getByRole("button", { name: "calibration:setup.applyTotal" }));
    expect(edgeValues()).toEqual([50, 10, 20]);
  });
});
