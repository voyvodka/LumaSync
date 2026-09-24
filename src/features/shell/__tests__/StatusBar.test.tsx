import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StatusBar } from "../StatusBar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../telemetry/hooks/useRuntimeTelemetry", () => ({
  useRuntimeTelemetry: () => ({ fps: 58.4, latencyMs: 4 }),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: () => Promise.resolve({}), save: vi.fn(), onSaved: () => () => {} },
}));

describe("StatusBar", () => {
  // The whole bar was `aria-live`, so a screen reader heard the FPS pill every
  // second. Chip changes worth hearing arrive through the notice queue.
  it("is not a live region", () => {
    render(
      <StatusBar
        uiMode="compact"
        items={[{ label: "USB", state: "OFF", kind: "off", onReconnect: vi.fn(), reconnectAriaLabel: "reconnect" }]}
      />,
    );

    const bar = screen.getByTestId("status-bar");
    expect(bar).not.toHaveAttribute("aria-live");
    expect(bar).not.toHaveAttribute("role", "status");
    expect(bar.querySelector("[aria-live]")).toBeNull();
    expect(screen.getByRole("button", { name: "reconnect" })).toBeInTheDocument();
  });

  // A left-out Hue is amber, yet still links to the bridge card.
  it("keeps a chip's link on every state but ok", () => {
    const { rerender } = render(
      <StatusBar
        uiMode="full"
        items={[{ label: "HUE", state: "LEFT OUT", kind: "active", onReconnect: vi.fn<() => void>(), reconnectAriaLabel: "open" }]}
      />,
    );
    expect(screen.getByRole("button", { name: "open" })).toBeInTheDocument();

    rerender(
      <StatusBar
        uiMode="full"
        items={[{ label: "HUE", state: "OK", kind: "ok", onReconnect: vi.fn<() => void>(), reconnectAriaLabel: "open" }]}
      />,
    );
    expect(screen.queryByRole("button", { name: "open" })).toBeNull();
  });

  it("draws a set-up link apart from a reconnect one", () => {
    render(
      <StatusBar
        uiMode="compact"
        items={[
          { label: "USB", state: "—", kind: "idle", onReconnect: vi.fn<() => void>(), reconnectAriaLabel: "set up", linkKind: "setUp" },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "set up" })).toHaveAttribute("data-link-kind", "setUp");
  });
});
