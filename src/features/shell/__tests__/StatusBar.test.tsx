import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StatusBar } from "../StatusBar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../telemetry/hooks/useRuntimeTelemetry", () => ({
  useRuntimeTelemetry: () => ({ fps: 58.4, latencyMs: 4, health: "ok" }),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: () => Promise.resolve({}), save: vi.fn(), onSaved: () => () => {} },
}));

const attention = (onAction = vi.fn<() => void>()) => ({ hint: "The strip is not connected.", action: "Devices", onAction });

describe("StatusBar", () => {
  // The whole bar was `aria-live`, so a screen reader heard the FPS pill every
  // second. Chip changes worth hearing arrive through the notice queue.
  it("is not a live region", () => {
    render(<StatusBar uiMode="compact" items={[{ id: "usb", label: "USB", state: "Off", kind: "off", attention: attention() }]} />);

    const bar = screen.getByTestId("status-bar");
    expect(bar).not.toHaveAttribute("aria-live");
    expect(bar).not.toHaveAttribute("role", "status");
    expect(bar.querySelector("[aria-live]")).toBeNull();
  });

  // Pressed, a chip says what is wrong beside it and offers the page, instead of taking the window there.
  it("opens its sentence beside it, and the action goes to the page", async () => {
    const onAction = vi.fn<() => void>();
    render(<StatusBar uiMode="full" items={[{ id: "usb", label: "USB", state: "Off", kind: "off", attention: attention(onAction) }]} />);

    const chip = screen.getByTestId("status-chip-USB");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chip);
    expect(await screen.findByText("The strip is not connected.")).toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Devices ›" }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  // A left-out Hue is amber, yet still opens its sentence; a healthy chip opens nothing.
  it("keeps a chip's sentence on every state but ok", () => {
    const { rerender } = render(
      <StatusBar uiMode="full" items={[{ id: "hue", label: "Hue", state: "Left out", kind: "active", attention: attention() }]} />,
    );
    expect(screen.getByTestId("status-chip-HUE").tagName).toBe("BUTTON");

    rerender(<StatusBar uiMode="full" items={[{ id: "hue", label: "Hue", state: "Ready", kind: "ok", attention: attention() }]} />);
    expect(screen.getByTestId("status-chip-HUE").tagName).not.toBe("BUTTON");
  });

  // The label is translated ("Yakalama"), so a test id taken from it would change with the language.
  it("names a chip's test id by its id, not its label", () => {
    render(<StatusBar uiMode="full" items={[{ id: "usb", label: "Yakalama", state: "Off", kind: "off" }]} />);
    expect(screen.getByTestId("status-chip-USB")).toBeInTheDocument();
  });

  // Shortcuts are listed in Settings → Help and the version in About.
  it("carries no key hints and no version", () => {
    render(<StatusBar uiMode="full" items={[{ id: "usb", label: "USB", state: "Ready", kind: "ok" }]} />);
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByTestId("status-bar").textContent).not.toMatch(/^v\d|\bv\d/);
  });

  it("ticks a new state word in, and not the one the window opens on", () => {
    const item = (state: string, kind: "ok" | "active") => ({ id: "hue", label: "Hue", state, kind });
    const { rerender } = render(<StatusBar uiMode="full" items={[item("Ready", "ok")]} />);
    expect(screen.getByText("Ready")).not.toHaveAttribute("data-changed");
    rerender(<StatusBar uiMode="full" items={[item("Streaming", "active")]} />);
    expect(screen.getByText("Streaming")).toHaveAttribute("data-changed");
  });
});

