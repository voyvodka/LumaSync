import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { createConnectionEventBus, type ConnectionEventBus } from "@/features/device/connectionEvents";

import { LED_SETUP_PROMPTED_KEY, useLedSetupPrompt, type LedSetupPromptInput } from "../useLedSetupPrompt";

const PORT = "/dev/cu.usbserial-1420";

let bus: ConnectionEventBus;
let IDLE: LedSetupPromptInput;
let CONNECTED: LedSetupPromptInput;

function mount(initial: LedSetupPromptInput) {
  return renderHook((props: LedSetupPromptInput) => useLedSetupPrompt(props), { initialProps: initial });
}

/** What `connectSelectedPort` announces when the user's Connect lands. */
function userConnects(port = PORT) {
  act(() => bus.emit({ portName: port, connected: true, userInitiated: true }));
}

/** What the boot auto-reconnect and recovery announce. */
function appReconnects(port = PORT) {
  act(() => bus.emit({ portName: port, connected: true }));
}

beforeEach(() => {
  sessionStorage.removeItem(LED_SETUP_PROMPTED_KEY);
  bus = createConnectionEventBus();
  IDLE = { ready: true, connected: false, hasCalibration: false, onLedSetup: false, connectionEvents: bus };
  CONNECTED = { ...IDLE, connected: true };
});

describe("useLedSetupPrompt", () => {
  it("names the port of the user's connect with no layout saved", () => {
    const hook = mount(IDLE);
    expect(hook.result.current).toBeNull();

    userConnects();
    hook.rerender(CONNECTED);
    expect(hook.result.current).toBe(PORT);
  });

  // It used to key on `connected` flipping, which the boot auto-reconnect does
  // on every launch.
  it("stays quiet when the app reconnected on its own", () => {
    const hook = mount(IDLE);

    appReconnects();
    hook.rerender(CONNECTED);
    expect(hook.result.current).toBeNull();

    // A later connect the user makes still prompts.
    userConnects();
    expect(hook.result.current).toBe(PORT);
  });

  it("stays quiet when a layout is saved", () => {
    const hook = mount({ ...IDLE, hasCalibration: true });
    userConnects();
    hook.rerender({ ...CONNECTED, hasCalibration: true });
    expect(hook.result.current).toBeNull();
  });

  // Before boot has read the store, "no layout" is only a guess.
  it("ignores a connect that landed before the saved state was read", () => {
    const hook = mount({ ...IDLE, ready: false });
    userConnects();
    hook.rerender(CONNECTED);
    expect(hook.result.current).toBeNull();
  });

  it("goes once LED Setup is opened, and does not come back", () => {
    const hook = mount(IDLE);
    userConnects();
    hook.rerender(CONNECTED);
    hook.rerender({ ...CONNECTED, onLedSetup: true });
    expect(hook.result.current).toBeNull();

    hook.rerender(CONNECTED);
    expect(hook.result.current).toBeNull();
  });

  it("goes when the strip is unplugged", () => {
    const hook = mount(IDLE);
    userConnects();
    hook.rerender(CONNECTED);
    hook.rerender(IDLE);
    expect(hook.result.current).toBeNull();
  });

  it("prompts once a session, across a reload", () => {
    const first = mount(IDLE);
    userConnects();
    first.rerender(CONNECTED);
    expect(first.result.current).toBe(PORT);
    first.unmount();

    const afterReload = mount(IDLE);
    userConnects();
    afterReload.rerender(CONNECTED);
    expect(afterReload.result.current).toBeNull();
  });
});
