import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { LED_SETUP_PROMPTED_KEY, useLedSetupPrompt, type LedSetupPromptInput } from "../useLedSetupPrompt";

const PORT = "/dev/cu.usbserial-1420";

const IDLE: LedSetupPromptInput = {
  ready: true,
  connected: false,
  connectedPort: null,
  hasCalibration: false,
  onLedSetup: false,
};
const CONNECTED: LedSetupPromptInput = { ...IDLE, connected: true, connectedPort: PORT };

function mount(initial: LedSetupPromptInput) {
  return renderHook((props: LedSetupPromptInput) => useLedSetupPrompt(props), { initialProps: initial });
}

beforeEach(() => {
  sessionStorage.removeItem(LED_SETUP_PROMPTED_KEY);
});

describe("useLedSetupPrompt", () => {
  it("names the port of the first connect with no layout saved", () => {
    const hook = mount(IDLE);
    expect(hook.result.current).toBeNull();

    hook.rerender(CONNECTED);
    expect(hook.result.current).toBe(PORT);
  });

  it("stays quiet when a layout is saved", () => {
    const hook = mount(IDLE);
    hook.rerender({ ...CONNECTED, hasCalibration: true });
    expect(hook.result.current).toBeNull();
  });

  // Before boot has read the store, "no layout" is only a guess.
  it("ignores a connect that landed before the saved state was read", () => {
    const hook = mount({ ...IDLE, ready: false });
    hook.rerender({ ...CONNECTED, ready: false });
    hook.rerender(CONNECTED);
    expect(hook.result.current).toBeNull();
  });

  it("goes once LED Setup is opened, and does not come back", () => {
    const hook = mount(IDLE);
    hook.rerender(CONNECTED);
    hook.rerender({ ...CONNECTED, onLedSetup: true });
    expect(hook.result.current).toBeNull();

    hook.rerender(CONNECTED);
    expect(hook.result.current).toBeNull();
  });

  it("goes when the strip is unplugged", () => {
    const hook = mount(IDLE);
    hook.rerender(CONNECTED);
    hook.rerender(IDLE);
    expect(hook.result.current).toBeNull();
  });

  it("prompts once a session, across a reload", () => {
    const first = mount(IDLE);
    first.rerender(CONNECTED);
    expect(first.result.current).toBe(PORT);
    first.unmount();

    const afterReload = mount(IDLE);
    afterReload.rerender(CONNECTED);
    expect(afterReload.result.current).toBeNull();
  });
});
