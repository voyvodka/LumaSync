import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DisplayInfo } from "@/shared/contracts/display";

const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn<() => Promise<{ selectedDisplayId?: string }>>() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: () => loadMock() },
}));

import { captureDisplayId, DisplaysCategory } from "../DisplaysCategory";

const DISPLAYS: DisplayInfo[] = [
  { id: "d1", label: "Built-in", width: 3024, height: 1964, x: 0, y: 0, scaleFactor: 2, isPrimary: true },
  { id: "d2", label: "Studio", width: 5120, height: 2880, x: 3024, y: 0, scaleFactor: 2, isPrimary: false },
];

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe("DisplaysCategory", () => {
  beforeEach(() => {
    loadMock.mockReset().mockResolvedValue({ selectedDisplayId: "d2" });
  });

  // Every card was a dashed ghost, and nothing said which one was captured.
  it("marks the display being captured, and only that one", async () => {
    render(<DisplaysCategory isActive displays={DISPLAYS} capturing />);
    await settle();

    const source = screen.getByTestId("display-card-d2");
    expect(source).toHaveTextContent("device:page.displays.capturing");
    expect(source).toHaveClass("is-on");
    expect(screen.getByTestId("display-card-d1")).not.toHaveTextContent("device:page.displays.capturing");
    expect(document.querySelector(".is-ghost")).toBeNull();
  });

  it("calls it the capture source while nothing is captured", async () => {
    render(<DisplaysCategory isActive displays={DISPLAYS} capturing={false} />);
    await settle();

    expect(screen.getByTestId("display-card-d2")).toHaveTextContent("device:page.displays.captureSource");
    expect(screen.queryByText("device:page.displays.capturing")).toBeNull();
  });

  it("links to the display picker in LED Setup", async () => {
    const onOpenLedSetup = vi.fn<() => void>();
    render(<DisplaysCategory isActive displays={DISPLAYS} onOpenLedSetup={onOpenLedSetup} />);
    await settle();

    screen.getByTestId("displays-open-led-setup").click();
    expect(onOpenLedSetup).toHaveBeenCalledOnce();
  });

  it("logs a failed read of the saved display", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    loadMock.mockRejectedValue(new Error("no state"));
    render(<DisplaysCategory isActive displays={DISPLAYS} />);
    await settle();

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("[LumaSync]"), expect.any(Error));
    // The primary is what Rust captures with nothing saved.
    expect(screen.getByTestId("display-card-d1")).toHaveClass("is-on");
    consoleError.mockRestore();
  });
});

describe("captureDisplayId", () => {
  it("is the saved display while it is connected", () => {
    expect(captureDisplayId(DISPLAYS, "d2")).toBe("d2");
  });

  it("falls back to the primary when nothing is saved, or the saved one is gone", () => {
    expect(captureDisplayId(DISPLAYS, null)).toBe("d1");
    expect(captureDisplayId(DISPLAYS, "unplugged")).toBe("d1");
  });

  it("is nothing with no displays", () => {
    expect(captureDisplayId([], "d2")).toBeNull();
  });
});
