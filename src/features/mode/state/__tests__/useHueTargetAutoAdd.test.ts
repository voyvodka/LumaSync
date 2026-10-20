import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { hueCredentialEvents } from "@/features/hue/hueCredentialEvents";
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

  it("adds Hue when a configured bridge is paired again", () => {
    const { onSelectTargets } = mount({ hueConfigured: true });

    hueCredentialEvents.emit({ reason: "paired" });

    expect(onSelectTargets).toHaveBeenCalledExactlyOnceWith(["usb", "hue"]);
  });

  it("ignores a pairing before the launch restore has answered", () => {
    const { onSelectTargets } = mount({ ready: false, hueConfigured: true });

    hueCredentialEvents.emit({ reason: "paired" });

    expect(onSelectTargets).not.toHaveBeenCalled();
  });

  it("leaves a Hue that is already selected alone when it is paired again", () => {
    const { onSelectTargets } = mount({ hueConfigured: true, selectedOutputTargets: ["usb", "hue"] });

    hueCredentialEvents.emit({ reason: "paired" });

    expect(onSelectTargets).not.toHaveBeenCalled();
  });

  it("leaves a first pairing to the area that completes it", () => {
    const { view, input, onSelectTargets } = mount();

    hueCredentialEvents.emit({ reason: "paired" });
    expect(onSelectTargets).not.toHaveBeenCalled();

    view.rerender({ ...input, hueConfigured: true });
    expect(onSelectTargets).toHaveBeenCalledExactlyOnceWith(["usb", "hue"]);
  });

  it("does not add Hue back when only the area changes", () => {
    const { onSelectTargets } = mount({ hueConfigured: true });

    hueCredentialEvents.emit({ reason: "area-selected" });

    expect(onSelectTargets).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted", () => {
    const { view, onSelectTargets } = mount({ hueConfigured: true });

    view.unmount();
    hueCredentialEvents.emit({ reason: "paired" });

    expect(onSelectTargets).not.toHaveBeenCalled();
  });
});
