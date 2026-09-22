import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { HueTelemetrySnapshot } from "@/shared/contracts/telemetry";

import { HueTelemetryGrid } from "../HueTelemetryGrid";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        "hue:runtime.codes.AUTH_INVALID_CREDENTIALS": "Credentials are invalid.",
        "telemetry:hue.errorAgo": "{{message}} — {{minutes}} min ago",
        "telemetry:hue.errorJustNow": "{{message}} — just now",
        "telemetry:hue.lastError": "Last Error",
      };
      let value = dict[key] ?? (typeof opts?.defaultValue === "string" ? opts.defaultValue : key);
      for (const [k, v] of Object.entries(opts ?? {})) value = value.replace(`{{${k}}}`, String(v));
      return value;
    },
  }),
}));

function snapshot(overrides: Partial<HueTelemetrySnapshot>): HueTelemetrySnapshot {
  return {
    state: "Failed",
    uptimeSecs: null,
    packetRate: 0,
    lastErrorCode: null,
    lastErrorAtSecs: null,
    totalReconnects: 0,
    successfulReconnects: 0,
    failedReconnects: 0,
    dtlsActive: false,
    dtlsCipher: null,
    dtlsConnectedAtSecs: null,
    ...overrides,
  };
}

describe("HueTelemetryGrid last error", () => {
  it("shows the translated message, not the raw code, and says just now under a minute", () => {
    render(
      <HueTelemetryGrid
        hue={snapshot({ lastErrorCode: "AUTH_INVALID_CREDENTIALS", lastErrorAtSecs: 12 })}
      />,
    );
    const cell = screen.getByText("Credentials are invalid — just now");
    expect(cell).toHaveAttribute("title", "AUTH_INVALID_CREDENTIALS");
  });

  it("counts minutes once the error is older than one", () => {
    render(
      <HueTelemetryGrid
        hue={snapshot({ lastErrorCode: "AUTH_INVALID_CREDENTIALS", lastErrorAtSecs: 185 })}
      />,
    );
    expect(screen.getByText("Credentials are invalid — 3 min ago")).toBeInTheDocument();
  });

  it("falls back to the raw code when no translation exists", () => {
    render(<HueTelemetryGrid hue={snapshot({ lastErrorCode: "SOMETHING_NEW", lastErrorAtSecs: null })} />);
    expect(screen.getByText("SOMETHING_NEW")).toBeInTheDocument();
  });
});
