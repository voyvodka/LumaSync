import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { UsbStripPlacement } from "@/shared/contracts/roomMap";

import type { ViewLight } from "../../../model/viewLights";
import type { HueIdentify } from "../../../state/useHueIdentify";
import { RoomViewDock } from "../RoomViewDock";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
}));

const light = (over: Partial<ViewLight> & Pick<ViewLight, "id" | "kind" | "name">): ViewLight => ({
  zone: null,
  family: null,
  lightCount: null,
  lightIds: [],
  ghost: false,
  unmatched: false,
  stripId: null,
  ...over,
});

const LIGHTS: ViewLight[] = [
  light({ id: "hue-0", kind: "hue", name: "Shelf", family: "floorLamp", lightIds: ["l-a"], zone: { name: "Sofa", colour: "red" } }),
  light({ id: "hue-1", kind: "hue", name: "Gone", ghost: true }),
  light({ id: "usb-s1", kind: "usb", name: "LED 60", stripId: "s1" }),
  light({ id: "tv", kind: "tv", name: "TV" }),
];
const STRIPS: UsbStripPlacement[] = [{ stripId: "s1", startX: 0, startY: 0, endX: 1, endY: 0, ledCount: 60, portName: "COM3" }];

const identify = (over: Partial<HueIdentify> = {}): HueIdentify => ({
  busyId: null,
  failure: null,
  identify: vi.fn<HueIdentify["identify"]>(),
  ...over,
});

/** The dock over a selection it shares with "the room": `pick` stands for a click there. */
function Harness({
  initial = null,
  pickRef,
  focusStage = vi.fn<() => void>(),
  onEdit = vi.fn<(id: string) => void>(),
  hueIdentify = identify(),
  canIdentify = true,
}: {
  initial?: string | null;
  pickRef?: { current: (id: string | null) => void };
  focusStage?: () => void;
  onEdit?: (id: string) => void;
  hueIdentify?: HueIdentify;
  canIdentify?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initial);
  if (pickRef) pickRef.current = setSelectedId;
  return (
    <RoomViewDock
      lights={LIGHTS}
      hue={null}
      selected={LIGHTS.find((l) => l.id === selectedId) ?? null}
      strips={STRIPS}
      stripStatus={() => ({ status: "connected", port: "COM3" })}
      identify={hueIdentify}
      canIdentify={canIdentify}
      onSelect={setSelectedId}
      onBack={() => setSelectedId(null)}
      onEdit={onEdit}
      onFocusStage={focusStage}
    />
  );
}

const chip = (id: string) => screen.getByTestId(`view-light-${id}`);
const liveButton = (testId: string) =>
  screen.getAllByTestId(testId).find((element) => !element.closest("[inert]")) as HTMLElement;

describe("RoomViewDock", () => {
  it("lists the Hue lights in the first row and the strip and screen in the second, named with their facts", () => {
    render(<Harness />);
    expect(chip("hue-0").getAttribute("aria-label")).toBe("Shelf, Sofa · roomMap:view.family.floorLamp");
    expect(chip("hue-1").getAttribute("aria-label")).toContain("roomMap:inspector.hueGhostShort");
    expect(chip("usb-s1").parentElement).toBe(chip("tv").parentElement);
    expect(chip("hue-0").parentElement).not.toBe(chip("tv").parentElement);
  });

  it("is one tab stop the arrows walk", () => {
    render(<Harness />);
    expect(chip("hue-0").tabIndex).toBe(0);
    expect(chip("hue-1").tabIndex).toBe(-1);
    act(() => chip("hue-0").focus());
    fireEvent.keyDown(chip("hue-0"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(chip("hue-1"));
    fireEvent.keyDown(chip("hue-1"), { key: "End" });
    expect(document.activeElement).toBe(chip("tv"));
  });

  it("opens the card on a keyboard pick and lands on its back button; Esc goes back to the same chip", () => {
    render(<Harness />);
    act(() => chip("hue-0").focus());
    fireEvent.click(chip("hue-0"), { detail: 0 });
    expect(screen.getAllByTestId("view-card-name").some((e) => e.textContent === "Shelf")).toBe(true);
    expect(document.activeElement).toBe(liveButton("view-card-back"));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(document.activeElement).toBe(chip("hue-0"));
  });

  it("hands the keys back to the room when the card is left by pointer", () => {
    const focusStage = vi.fn<() => void>();
    render(<Harness initial="hue-0" focusStage={focusStage} />);
    fireEvent.click(liveButton("view-card-back"), { detail: 1 });
    expect(focusStage).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(chip("hue-0"));
  });

  it("shows another lamp's card in place, without a page swap, and announces it", () => {
    const pickRef = { current: (_id: string | null) => {} };
    render(<Harness initial="hue-0" pickRef={pickRef} />);
    act(() => pickRef.current("tv"));
    expect(screen.getAllByTestId("view-card-name").map((e) => e.textContent)).toEqual(["TV"]);
    expect(screen.getByRole("status").textContent).toBe('roomMap:view.selected {"name":"TV"}');
  });

  it("says why identify is not there for a light the bridge never matched", () => {
    render(<Harness initial="hue-1" />);
    expect(liveButton("view-card-identify").getAttribute("title")).toBe("roomMap:inspector.hueGhostShort");
  });

  it("hands the keys back to the room after a pointer pick", () => {
    const focusStage = vi.fn<() => void>();
    render(<Harness focusStage={focusStage} />);
    fireEvent.click(chip("tv"), { detail: 1 });
    expect(focusStage).toHaveBeenCalledTimes(1);
  });

  it("announces a light picked in the room and leaves focus alone", () => {
    const pickRef = { current: (_id: string | null) => {} };
    const focusStage = vi.fn<() => void>();
    render(<Harness pickRef={pickRef} focusStage={focusStage} />);
    act(() => pickRef.current("hue-0"));
    expect(screen.getByRole("status").textContent).toBe('roomMap:view.selected {"name":"Shelf"}');
    expect(focusStage).not.toHaveBeenCalled();
  });

  it("identifies a Hue light's own lights, and offers nothing that cannot work", () => {
    const hueIdentify = identify();
    const { unmount } = render(<Harness initial="hue-0" hueIdentify={hueIdentify} />);
    fireEvent.click(liveButton("view-card-identify"));
    expect(hueIdentify.identify).toHaveBeenCalledWith("hue-0", ["l-a"]);
    unmount();

    const none = identify();
    render(<Harness initial="hue-0" hueIdentify={none} canIdentify={false} />);
    const button = liveButton("view-card-identify");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(none.identify).not.toHaveBeenCalled();
  });

  it("says why identify failed, and that a stream holds the lights", () => {
    render(<Harness initial="hue-0" hueIdentify={identify({ failure: { id: "hue-0", code: "HUE_IDENTIFY_BLOCKED_STREAMING" } })} />);
    expect(screen.getByText("hue:channelMap.identifyBlocked")).toBeTruthy();
  });

  it("shows a strip's port and a ghost's warning instead of facts, and no identify for either", () => {
    const { unmount } = render(<Harness initial="usb-s1" />);
    expect(screen.getByText("COM3")).toBeTruthy();
    expect(screen.queryByTestId("view-card-identify")).toBeNull();
    unmount();
    render(<Harness initial="hue-1" />);
    expect(screen.getAllByText("roomMap:inspector.hueGhostShort").length).toBeGreaterThan(0);
  });

  it("opens the plan on the light", () => {
    const onEdit = vi.fn<(id: string) => void>();
    render(<Harness initial="tv" onEdit={onEdit} />);
    fireEvent.click(screen.getByText("roomMap:view.edit"));
    expect(onEdit).toHaveBeenCalledWith("tv");
  });
});
