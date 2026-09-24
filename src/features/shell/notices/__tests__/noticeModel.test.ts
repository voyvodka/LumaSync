import { describe, expect, it } from "vitest";

import { SECTION_IDS } from "@/shared/contracts/shell";

import { currentNoticeView, isShownByView, NOTICE_VIEW } from "../noticeModel";

describe("currentNoticeView", () => {
  it("names Devices → Hue only while full mode shows it", () => {
    const hue = { uiMode: "full", activeSection: SECTION_IDS.DEVICES, visibleDeviceCategory: "hue" } as const;
    expect(currentNoticeView(hue)).toBe(NOTICE_VIEW.DEVICES_HUE);
    expect(currentNoticeView({ ...hue, visibleDeviceCategory: "usb" })).toBeNull();
    expect(currentNoticeView({ ...hue, visibleDeviceCategory: null })).toBeNull();
    expect(currentNoticeView({ ...hue, activeSection: SECTION_IDS.LIGHTS })).toBeNull();
  });

  // Compact has no Devices page, so nothing it shows may be hidden for one.
  it("names nothing in compact, whatever the store still holds", () => {
    expect(
      currentNoticeView({ uiMode: "compact", activeSection: SECTION_IDS.DEVICES, visibleDeviceCategory: "hue" }),
    ).toBeNull();
  });
});

describe("isShownByView", () => {
  it("matches a notice to the view it names, and never to no view", () => {
    expect(isShownByView({ shownBy: NOTICE_VIEW.DEVICES_HUE }, NOTICE_VIEW.DEVICES_HUE)).toBe(true);
    expect(isShownByView({ shownBy: NOTICE_VIEW.DEVICES_HUE }, null)).toBe(false);
    expect(isShownByView({}, NOTICE_VIEW.DEVICES_HUE)).toBe(false);
  });
});
