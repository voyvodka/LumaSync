/**
 * FirmwareProfilePicker — v1.4 G11 serial protocol toggle.
 *
 * A 2-tile radio group that lets the user choose between the LumaSync v1
 * protocol (handshake + telemetry) and Adalight (plain interoperability
 * for Prismatik / Hyperion / Boblight / DIY Arduino). Selection is
 * persisted to `shellStore.firmwareProfile`; when Adalight is active the
 * brightness slider in `SolidColorPanel` is locked because the Adalight
 * wire format has brightness baked into the firmware (see D2 decision).
 *
 * The picker is a simple two-button `role="radiogroup"` rather than a
 * `<select>` to stay aligned with the existing `lm-settings-seg` look and
 * to surface the description copy directly (a `<select>` would hide it).
 *
 * Accessibility:
 *   - `role="radiogroup"` + per-tile `role="radio"` + `aria-checked`.
 *   - Arrow-key navigation between tiles (Left/Right, Up/Down).
 *   - Clear visual difference for the selected tile — amber-ringed card.
 *   - Adalight notice is surfaced as visible text AND tooltip via `title`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  FIRMWARE_PROFILE,
  type FirmwareProfile,
} from "../../../../shared/contracts/device";
import { shellStore } from "../../../persistence/shellStore";

const DEFAULT_PROFILE: FirmwareProfile = FIRMWARE_PROFILE.LUMASYNC_V1;

interface ProfileTileProps {
  profile: FirmwareProfile;
  label: string;
  description: string;
  notice?: string;
  checked: boolean;
  onSelect: (profile: FirmwareProfile) => void;
  onKeyNavigate: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  tileRef: React.RefObject<HTMLButtonElement | null>;
}

function ProfileTile({
  profile,
  label,
  description,
  notice,
  checked,
  onSelect,
  onKeyNavigate,
  tileRef,
}: ProfileTileProps) {
  return (
    <button
      ref={tileRef}
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={checked ? 0 : -1}
      onClick={() => onSelect(profile)}
      onKeyDown={onKeyNavigate}
      className={`lm-fw-tile${checked ? " is-on" : ""}`}
      style={{
        all: "unset",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "12px 14px",
        borderRadius: 8,
        border: `1px solid ${checked ? "rgba(255, 176, 32, 0.4)" : "#252b34"}`,
        background: checked ? "rgba(255, 176, 32, 0.08)" : "#0a0c0f",
        color: checked ? "var(--lm-amber, #ffb020)" : "#eaeef4",
        flex: 1,
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          letterSpacing: "-0.005em",
          color: checked ? "var(--lm-amber, #ffb020)" : "#eaeef4",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--lm-mono, \"IBM Plex Mono\", ui-monospace, monospace)",
          fontSize: 10,
          color: "#8a94a3",
          lineHeight: 1.45,
        }}
      >
        {description}
      </div>
      {notice && (
        <div
          style={{
            fontFamily: "var(--lm-mono, \"IBM Plex Mono\", ui-monospace, monospace)",
            fontSize: 9.5,
            color: checked ? "var(--lm-amber, #ffb020)" : "#4d5564",
            letterSpacing: "0.02em",
            marginTop: 2,
          }}
          title={notice}
        >
          ⚠ {notice}
        </div>
      )}
    </button>
  );
}

export interface FirmwareProfilePickerProps {
  /** Initial profile from shellStore — parent hydrates before first paint. */
  initialProfile?: FirmwareProfile;
  /**
   * Fired after persistence completes so the parent can react (the LED
   * section uses it to recompute whether the brightness slider should
   * visually lock). Called with the NEW selection only — the parent can
   * compare against previous state if needed.
   */
  onProfileChange?: (next: FirmwareProfile) => void;
}

export function FirmwareProfilePicker({
  initialProfile,
  onProfileChange,
}: FirmwareProfilePickerProps) {
  const { t } = useTranslation("common");
  const [profile, setProfile] = useState<FirmwareProfile>(
    initialProfile ?? DEFAULT_PROFILE,
  );

  const v1Ref = useRef<HTMLButtonElement | null>(null);
  const adalightRef = useRef<HTMLButtonElement | null>(null);

  // Defensive hydrate when the parent does not supply `initialProfile`.
  useEffect(() => {
    if (initialProfile) return;
    let cancelled = false;
    void shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        if (state.firmwareProfile) setProfile(state.firmwareProfile);
      })
      .catch((error) => {
        console.error("[LumaSync] FirmwareProfilePicker hydrate failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [initialProfile]);

  const handleSelect = useCallback(
    (next: FirmwareProfile) => {
      if (next === profile) return;
      setProfile(next);
      void shellStore
        .save({ firmwareProfile: next })
        .catch((error) => {
          console.error(
            "[LumaSync] shellStore.save(firmwareProfile) failed:",
            error,
          );
        });
      onProfileChange?.(next);
    },
    [onProfileChange, profile],
  );

  const handleKeyNavigate = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        const nextProfile: FirmwareProfile =
          profile === FIRMWARE_PROFILE.LUMASYNC_V1
            ? FIRMWARE_PROFILE.ADALIGHT
            : FIRMWARE_PROFILE.LUMASYNC_V1;
        handleSelect(nextProfile);
        // Move focus to the newly selected tile so roving tabindex works.
        const targetRef = nextProfile === FIRMWARE_PROFILE.ADALIGHT ? adalightRef : v1Ref;
        targetRef.current?.focus();
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        const nextProfile: FirmwareProfile =
          profile === FIRMWARE_PROFILE.ADALIGHT
            ? FIRMWARE_PROFILE.LUMASYNC_V1
            : FIRMWARE_PROFILE.ADALIGHT;
        handleSelect(nextProfile);
        const targetRef = nextProfile === FIRMWARE_PROFILE.ADALIGHT ? adalightRef : v1Ref;
        targetRef.current?.focus();
      }
    },
    [handleSelect, profile],
  );

  return (
    <section className="lm-settings-group">
      <div className="lm-settings-group-h">
        <span className="t">{t("ledSettings.firmwareProfile.title")}</span>
        <span className="sub">{t("ledSettings.firmwareProfile.description")}</span>
      </div>
      <div
        role="radiogroup"
        aria-label={t("ledSettings.firmwareProfile.title")}
        style={{
          display: "flex",
          gap: 10,
          padding: 14,
          flexWrap: "wrap",
        }}
      >
        <ProfileTile
          profile={FIRMWARE_PROFILE.LUMASYNC_V1}
          label={t("ledSettings.firmwareProfile.lumasyncV1Label")}
          description={t("ledSettings.firmwareProfile.lumasyncV1Description")}
          checked={profile === FIRMWARE_PROFILE.LUMASYNC_V1}
          onSelect={handleSelect}
          onKeyNavigate={handleKeyNavigate}
          tileRef={v1Ref}
        />
        <ProfileTile
          profile={FIRMWARE_PROFILE.ADALIGHT}
          label={t("ledSettings.firmwareProfile.adalightLabel")}
          description={t("ledSettings.firmwareProfile.adalightDescription")}
          notice={
            profile === FIRMWARE_PROFILE.ADALIGHT
              ? t("ledSettings.firmwareProfile.brightnessDisabledTooltip")
              : undefined
          }
          checked={profile === FIRMWARE_PROFILE.ADALIGHT}
          onSelect={handleSelect}
          onKeyNavigate={handleKeyNavigate}
          tileRef={adalightRef}
        />
      </div>
    </section>
  );
}
