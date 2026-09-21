/**
 * The bridge exists for one reason — `unlisten` — so that is what these
 * pin down. The rest is here because a registry that leaks or double-fires
 * is indistinguishable from an app bug when you are reading the console.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleEventPluginCommand,
  isEventPluginCommand,
  listenerCount,
  resetEventBridge,
} from "../eventBridge";

const runCallback = vi.fn();

beforeEach(() => {
  resetEventBridge();
  runCallback.mockClear();
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { runCallback };
});

function listen(event: string, handler: number): unknown {
  return handleEventPluginCommand("plugin:event|listen", {
    event,
    target: { kind: "Any" },
    handler,
  });
}

function unlisten(event: string, eventId: number): unknown {
  return handleEventPluginCommand("plugin:event|unlisten", { event, eventId });
}

function emit(event: string, payload?: unknown): unknown {
  return handleEventPluginCommand("plugin:event|emit", { event, payload });
}

describe("the event bridge", () => {
  it("claims every event-plugin command and nothing else", () => {
    expect(isEventPluginCommand("plugin:event|listen")).toBe(true);
    expect(isEventPluginCommand("plugin:store|get")).toBe(false);
    expect(isEventPluginCommand("get_serial_connection_status")).toBe(false);
  });

  it("returns the handler id, because that is what unlisten is given back", () => {
    expect(listen("a", 7)).toBe(7);
  });

  it("removes a listener on unlisten — the whole reason this file exists", () => {
    // The upstream mock reads `args.id` while Tauri sends `args.eventId`, so
    // its `indexOf(undefined)` never matches and the entry survives forever.
    listen("a", 7);
    expect(listenerCount("a")).toBe(1);

    unlisten("a", 7);
    expect(listenerCount("a")).toBe(0);

    emit("a", { x: 1 });
    expect(runCallback).not.toHaveBeenCalled();
  });

  it("delivers the event/id/payload shape a real listener unwraps", () => {
    listen("ambilight://edge-signal", 11);
    emit("ambilight://edge-signal", { seq: 3 });

    expect(runCallback).toHaveBeenCalledWith(11, {
      event: "ambilight://edge-signal",
      id: 11,
      payload: { seq: 3 },
    });
  });

  it("delivers to every subscriber of the same event", () => {
    listen("a", 1);
    listen("a", 2);
    emit("a");
    expect(runCallback).toHaveBeenCalledTimes(2);
  });

  it("does not cross-deliver between events", () => {
    listen("a", 1);
    listen("b", 2);
    emit("a");
    expect(runCallback).toHaveBeenCalledTimes(1);
    expect(runCallback).toHaveBeenCalledWith(1, expect.anything());
  });

  it("survives a handler that unsubscribes itself mid-emit", () => {
    // Iterating the live array would shift it under the loop and skip the
    // next subscriber — the classic self-removal bug.
    listen("a", 1);
    listen("a", 2);
    runCallback.mockImplementation((id: number) => {
      if (id === 1) unlisten("a", 1);
    });

    emit("a");
    expect(runCallback).toHaveBeenCalledTimes(2);
  });

  it("drops the event key once its last listener leaves", () => {
    listen("a", 1);
    unlisten("a", 1);
    expect(listenerCount("a")).toBe(0);
  });

  it("ignores an unlisten for an id that was never registered", () => {
    listen("a", 1);
    unlisten("a", 999);
    expect(listenerCount("a")).toBe(1);
  });

  it("leaves an unknown event-plugin method unanswered rather than faking success", () => {
    // `null` would read as "handled"; `undefined` is what makes boot.ts throw
    // and name the method instead of the app silently losing it.
    expect(handleEventPluginCommand("plugin:event|something_new", { event: "a" })).toBeUndefined();
  });
});
