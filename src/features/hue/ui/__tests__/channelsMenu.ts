import { fireEvent, screen } from "@testing-library/react";

/** Save and pull sit behind the channels' "…": opens it when it is closed, and hands back the item. */
export function bridgeAction(which: "save" | "pull"): HTMLElement {
  const name = which === "save" ? /saveToBridgeMenu$/ : /pullFromBridge$/;
  const item = screen.queryByRole("button", { name });
  if (item) return item;
  fireEvent.click(screen.getByRole("button", { name: /channelMap\.more/ }));
  return screen.getByRole("button", { name });
}

/** What the channels row says about the bridge (its value). */
export function channelsValue(): string {
  return screen.getByTestId("hue-channels-value").textContent ?? "";
}
