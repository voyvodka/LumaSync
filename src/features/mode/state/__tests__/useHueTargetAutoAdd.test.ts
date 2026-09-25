import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useHueTargetAutoAdd, type HueTargetAutoAddInput } from "../useHueTargetAutoAdd";

function mount(initial: Partial<HueTargetAutoAddInput> = {}) {
  const onSelectTargets = vi.fn<HueTargetAutoAddInput["onSelectTargets"]>().mockResolvedValue(undefined);
  const input: HueTargetAutoAddInput = {
    ready: true,
    hueConfigured: false,
    selectedOutputTargets: ["usb"],
    onSelectTargets,
    ...initial,
  };
  const view = renderHook((props: HueTargetAutoAddInput) => useHueTargetAutoAdd(props), { initialProps: input });
  return { view, input, onSelectTargets };
}

describe("useHueTargetAutoAdd", () => {
  // A fresh install selects only `usb`; finishing Hue setup never added `hue`,
  // so a Hue-only user had nothing to run a mode on.
  it("adds Hue to the saved outputs once Hue setup completes", () => {
    const { view, input, onSelectTargets } = mount();

    view.rerender({ ...input, hueConfigured: true });

    expect(onSelectTargets).toHaveBeenCalledExactlyOnceWith(["usb", "hue"]);
  });

  it("leaves a Hue that was set up at launch as the saved selection has it", () => {
    const { view, input, onSelectTargets } = mount({ ready: false, hueConfigured: true });

    view.rerender({ ...input, ready: true, hueConfigured: true });

    expect(onSelectTargets).not.toHaveBeenCalled();
  });

  it("does nothing when Hue is already selected", () => {
    const { view, input, onSelectTargets } = mount({ selectedOutputTargets: ["hue"] });

    view.rerender({ ...input, hueConfigured: true });

    expect(onSelectTargets).not.toHaveBeenCalled();
  });

  it("waits for the launch restore before reading the selection", () => {
    const { view, input, onSelectTargets } = mount({ ready: false });

    view.rerender({ ...input, ready: false, hueConfigured: true });

    expect(onSelectTargets).not.toHaveBeenCalled();
  });
});
