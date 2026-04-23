/**
 * GlobalErrorBoundary — render fallback tests.
 *
 * Covers:
 *  - A thrown child triggers `role="alert"` fallback (no white-screen).
 *  - `console.error` is invoked with the [LumaSync] prefix so the
 *    tauri-plugin-log sink picks the entry up.
 *  - "Show details" toggle expands the stack-trace <pre>.
 *  - "Copy error" calls navigator.clipboard.writeText with a payload
 *    including the error name + stack.
 *  - "Show logs" invokes the open_log_dir Tauri command.
 *  - "Restart" calls the @tauri-apps/plugin-process relaunch() API; if
 *    the dynamic import or the call itself rejects, the handler falls
 *    back to `window.location.reload()`.
 *
 * The hardcoded-English fallback path is exercised implicitly: the
 * raw `GlobalErrorBoundary` class is used without the i18n wrapper so
 * no `t` prop is threaded, which mirrors the bootstrap-race scenario.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GlobalErrorBoundary } from "../GlobalErrorBoundary";

const relaunchMock = vi.hoisted(() => vi.fn<() => Promise<void>>(() => Promise.resolve()));
const invokeMock = vi.hoisted(() => vi.fn<(cmd: string) => Promise<unknown>>(() => Promise.resolve()));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: relaunchMock,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

function Boom(): null {
  throw new Error("boom from test child");
}

describe("GlobalErrorBoundary — fallback surface", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Silence React's own error logs so the output stays readable;
    // we still assert against the spy below for the [LumaSync] entry.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    relaunchMock.mockReset();
    relaunchMock.mockImplementation(() => Promise.resolve());
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the fallback alert when a child throws", () => {
    render(
      <GlobalErrorBoundary>
        <Boom />
      </GlobalErrorBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    // Fallback copy is the hardcoded EN string when no `t` prop is provided.
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^restart$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /show logs/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /copy error/i }),
    ).toBeInTheDocument();
  });

  it("logs the uncaught error via console.error with [LumaSync] prefix", () => {
    render(
      <GlobalErrorBoundary>
        <Boom />
      </GlobalErrorBoundary>,
    );

    const prefixed = consoleErrorSpy.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        call[0].includes("[LumaSync]") &&
        call[0].includes("GlobalErrorBoundary"),
    );
    expect(prefixed).toBeTruthy();
  });

  it("toggles the details <pre> when the show/hide button is clicked", () => {
    render(
      <GlobalErrorBoundary>
        <Boom />
      </GlobalErrorBoundary>,
    );

    const toggle = screen.getByRole("button", { name: /show details/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    const stack = document.getElementById("lm-errboundary-details");
    expect(stack).not.toBeNull();
    expect(stack?.textContent ?? "").toContain("boom from test child");
    expect(screen.getByRole("button", { name: /hide details/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("calls navigator.clipboard.writeText with the error payload on Copy error", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    // happy-dom provides navigator but no clipboard API by default.
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <GlobalErrorBoundary>
        <Boom />
      </GlobalErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: /copy error/i }));

    // The handler is async; flush the microtask queue.
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = writeText.mock.calls[0]?.[0] ?? "";
    expect(payload).toContain("[LumaSync] Uncaught render error");
    expect(payload).toContain("boom from test child");
  });

  it("invokes the open_log_dir Tauri command when Show logs is clicked", async () => {
    render(
      <GlobalErrorBoundary>
        <Boom />
      </GlobalErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: /show logs/i }));

    // Handler is async; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("open_log_dir");
  });

  it("calls plugin-process relaunch() when Restart is clicked", async () => {
    render(
      <GlobalErrorBoundary>
        <Boom />
      </GlobalErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: /^restart$/i }));

    // Dynamic import settles asynchronously; poll until the mock
    // resolves rather than guessing at microtask counts.
    await vi.waitFor(() => {
      expect(relaunchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("falls back to window.location.reload when relaunch rejects", async () => {
    relaunchMock.mockImplementationOnce(() =>
      Promise.reject(new Error("plugin not available")),
    );
    const reloadSpy = vi.fn();
    // JSDOM / happy-dom guards location.reload as read-only; stub the whole
    // object so the spy records the call without touching navigation.
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    });

    try {
      render(
        <GlobalErrorBoundary>
          <Boom />
        </GlobalErrorBoundary>,
      );

      fireEvent.click(screen.getByRole("button", { name: /^restart$/i }));

      // Dynamic import + rejection fallback is async; wait for the
      // catch-path reload spy instead of flushing by hand.
      await vi.waitFor(() => {
        expect(reloadSpy).toHaveBeenCalledTimes(1);
      });
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });
});
