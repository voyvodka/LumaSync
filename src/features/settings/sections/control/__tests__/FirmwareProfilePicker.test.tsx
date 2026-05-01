/**
 * Bug H4 — FirmwareProfilePicker mismatched-profile gating + override.
 *
 * The picker reads `advertisedFirmwareProfile` (forwarded by the parent
 * via the `advertisedFirmwareProfile` prop in tests; production flow
 * subscribes to `useDeviceConnection`) and disables the mismatched tile
 * with a localized tooltip. A power-user "Use anyway" toggle re-enables
 * the disabled tile, and committing a mismatched profile surfaces a
 * confirmation dialog with a "Don't ask again" checkbox.
 *
 * The tests below cover the four behaviour gates:
 *   1. Disabled state when the health check has reported a profile.
 *   2. Fully enabled state when the field is `undefined`.
 *   3. Override flow surfaces the warning dialog.
 *   4. "Don't ask again" preference suppresses subsequent dialogs.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FIRMWARE_PROFILE } from "../../../../../shared/contracts/device";
import { FirmwareProfilePicker } from "../FirmwareProfilePicker";

// ---- i18n stub ----------------------------------------------------------
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      let value = key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          value = value.replace(`{{${k}}}`, String(v));
        }
      }
      return value;
    },
  }),
}));

// ---- shellStore stub ----------------------------------------------------
const mockState = {
  firmwareProfile: undefined as string | undefined,
  dontWarnFirmwareProfileMismatch: undefined as boolean | undefined,
};
const mockSave = vi.fn(async (_partial: Record<string, unknown>) => undefined);

vi.mock("../../../../persistence/shellStore", () => ({
  shellStore: {
    load: vi.fn(async () => ({ ...mockState })),
    save: (partial: Record<string, unknown>) => mockSave(partial),
  },
}));

// ---- useDeviceConnection stub -------------------------------------------
// The picker subscribes to the device-connection controller for the
// `latestHealthCheck.advertisedFirmwareProfile` field. Tests bypass the
// hook by passing the prop directly, but the hook still gets called so
// it must return a state shape with `latestHealthCheck`.
vi.mock("../../../../device/useDeviceConnection", () => ({
  useDeviceConnection: () => ({ latestHealthCheck: null }),
}));

beforeEach(() => {
  mockState.firmwareProfile = undefined;
  mockState.dontWarnFirmwareProfileMismatch = undefined;
  mockSave.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FirmwareProfilePicker — Bug H4 mismatch gating", () => {
  it("disables the non-advertised tile when health check has reported a profile", async () => {
    render(
      <FirmwareProfilePicker
        initialProfile={FIRMWARE_PROFILE.ADALIGHT}
        advertisedFirmwareProfile={FIRMWARE_PROFILE.LUMASYNC_V1}
        initialDontWarnFirmwareProfileMismatch={false}
      />,
    );

    const v1Tile = screen.getByRole("radio", {
      name: /lumasyncV1Label/,
    });
    const adalightTile = screen.getByRole("radio", {
      name: /adalightLabel/,
    });

    // The tile that matches the firmware-advertised profile is enabled.
    expect(v1Tile.getAttribute("aria-disabled")).toBeNull();
    // The mismatched tile is aria-disabled with a tooltip via title.
    expect(adalightTile.getAttribute("aria-disabled")).toBe("true");
    expect(adalightTile.getAttribute("title")).toMatch(/mismatchTooltip/);
  });

  it("leaves all profiles enabled when advertisedFirmwareProfile is undefined", () => {
    render(
      <FirmwareProfilePicker
        initialProfile={FIRMWARE_PROFILE.LUMASYNC_V1}
        advertisedFirmwareProfile={undefined}
        initialDontWarnFirmwareProfileMismatch={false}
      />,
    );

    const v1Tile = screen.getByRole("radio", {
      name: /lumasyncV1Label/,
    });
    const adalightTile = screen.getByRole("radio", {
      name: /adalightLabel/,
    });

    expect(v1Tile.getAttribute("aria-disabled")).toBeNull();
    expect(adalightTile.getAttribute("aria-disabled")).toBeNull();
    // No "Use anyway" affordance either, because there is nothing to
    // override when the firmware has not declared its profile.
    expect(screen.queryByTestId("lm-fw-use-anyway")).toBeNull();
  });

  it("surfaces the override warning dialog on mismatched commit and persists 'don't ask again'", async () => {
    const user = userEvent.setup();
    const onProfileChange = vi.fn();

    render(
      <FirmwareProfilePicker
        initialProfile={FIRMWARE_PROFILE.LUMASYNC_V1}
        advertisedFirmwareProfile={FIRMWARE_PROFILE.LUMASYNC_V1}
        initialDontWarnFirmwareProfileMismatch={false}
        onProfileChange={onProfileChange}
      />,
    );

    // 1. Toggle "Use anyway" so the mismatched tile becomes selectable.
    const overrideToggle = screen.getByTestId("lm-fw-use-anyway");
    await user.click(overrideToggle);

    // 2. Click the (now-enabled) Adalight tile.
    const adalightTile = screen.getByRole("radio", {
      name: /adalightLabel/,
    });
    expect(adalightTile.getAttribute("aria-disabled")).toBeNull();
    await user.click(adalightTile);

    // 3. Dialog appears, profile NOT yet committed.
    expect(screen.getByTestId("lm-fw-override-dialog")).toBeInTheDocument();
    expect(onProfileChange).not.toHaveBeenCalled();

    // 4. Tick "don't ask again" + confirm.
    await user.click(screen.getByTestId("lm-fw-override-dont-ask"));
    await user.click(screen.getByTestId("lm-fw-override-confirm"));

    // 5. Profile commits + don't-ask-again persists.
    await waitFor(() => {
      expect(onProfileChange).toHaveBeenCalledWith(FIRMWARE_PROFILE.ADALIGHT);
    });
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ firmwareProfile: FIRMWARE_PROFILE.ADALIGHT }),
    );
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ dontWarnFirmwareProfileMismatch: true }),
    );
    expect(screen.queryByTestId("lm-fw-override-dialog")).toBeNull();
  });

  it("honors don't-ask-again preference and skips the dialog on mismatched commit", async () => {
    const user = userEvent.setup();
    const onProfileChange = vi.fn();

    render(
      <FirmwareProfilePicker
        initialProfile={FIRMWARE_PROFILE.LUMASYNC_V1}
        advertisedFirmwareProfile={FIRMWARE_PROFILE.LUMASYNC_V1}
        initialDontWarnFirmwareProfileMismatch={true}
        onProfileChange={onProfileChange}
      />,
    );

    await user.click(screen.getByTestId("lm-fw-use-anyway"));
    const adalightTile = screen.getByRole("radio", {
      name: /adalightLabel/,
    });
    await user.click(adalightTile);

    // No dialog when the preference is preset.
    expect(screen.queryByTestId("lm-fw-override-dialog")).toBeNull();

    // Profile commits straight through.
    await waitFor(() => {
      expect(onProfileChange).toHaveBeenCalledWith(FIRMWARE_PROFILE.ADALIGHT);
    });
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ firmwareProfile: FIRMWARE_PROFILE.ADALIGHT }),
    );
    // Don't-ask-again was never written this run because it was already
    // true before mount.
    expect(mockSave).not.toHaveBeenCalledWith(
      expect.objectContaining({ dontWarnFirmwareProfileMismatch: true }),
    );
  });

  it("ESC closes the override warning dialog without committing", async () => {
    const user = userEvent.setup();
    const onProfileChange = vi.fn();

    render(
      <FirmwareProfilePicker
        initialProfile={FIRMWARE_PROFILE.LUMASYNC_V1}
        advertisedFirmwareProfile={FIRMWARE_PROFILE.LUMASYNC_V1}
        initialDontWarnFirmwareProfileMismatch={false}
        onProfileChange={onProfileChange}
      />,
    );

    await user.click(screen.getByTestId("lm-fw-use-anyway"));
    await user.click(
      screen.getByRole("radio", { name: /adalightLabel/ }),
    );
    expect(screen.getByTestId("lm-fw-override-dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("lm-fw-override-dialog")).toBeNull();
    });
    expect(onProfileChange).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalledWith(
      expect.objectContaining({ firmwareProfile: FIRMWARE_PROFILE.ADALIGHT }),
    );
  });
});
