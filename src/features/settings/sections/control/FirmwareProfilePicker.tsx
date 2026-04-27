/**
 * FirmwareProfilePicker — v1.4 G11 serial protocol toggle (v1.5 H4 hardening).
 *
 * A 2-tile radio group that lets the user choose between the LumaSync v1
 * protocol (handshake + telemetry) and Adalight (plain interoperability
 * for Prismatik / Hyperion / Boblight / DIY Arduino). Selection is
 * persisted to `shellStore.firmwareProfile`; when Adalight is active the
 * brightness slider in `SolidColorPanel` is locked because the Adalight
 * wire format has brightness baked into the firmware (see D2 decision).
 *
 * v1.5 Bug H4 — when the last serial health check reported a definite
 * `advertisedFirmwareProfile`, the mismatched tile is rendered as
 * `aria-disabled` with a localized tooltip. This stops the silent
 * "Adalight selected, but firmware speaks LumaSync v1" failure mode where
 * USB no-ops while Hue keeps streaming. Power users with custom firmware
 * can flip an "Use anyway" override toggle, which re-enables every tile
 * and surfaces a confirmation dialog before persisting the mismatched
 * choice. The dialog has a "Don't ask again" checkbox that persists the
 * preference into `ShellState.dontWarnFirmwareProfileMismatch`.
 *
 * Absence semantics: when `advertisedFirmwareProfile` is `undefined`
 * (handshake never ran, timeout, protocol error, legacy firmware), every
 * tile stays enabled and no mismatch UX is shown. The picker becomes a
 * pure user-driven choice, exactly like the v1.4 surface.
 *
 * Accessibility:
 *   - `role="radiogroup"` + per-tile `role="radio"` + `aria-checked`.
 *   - Disabled tiles carry `aria-disabled="true"`, `tabIndex=-1`, and a
 *     `title` + `aria-describedby` pointing at the tooltip text.
 *   - Arrow-key navigation skips disabled tiles unless the override
 *     toggle is on.
 *   - Override dialog: `role="dialog"`, `aria-modal="true"`,
 *     `aria-labelledby`, focus trap, ESC = cancel, Enter = confirm.
 *   - Tap targets ≥ 32 px (tile padding 12+12=24 + content height ≥ 8).
 *   - Forced-colors / reduced-motion respected via `lm-fw-tile` class
 *     rules in `src/styles.css`.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  FIRMWARE_PROFILE,
  type FirmwareProfile,
} from "../../../../shared/contracts/device";
import { useDeviceConnection } from "../../../device/useDeviceConnection";
import { shellStore } from "../../../persistence/shellStore";

const DEFAULT_PROFILE: FirmwareProfile = FIRMWARE_PROFILE.LUMASYNC_V1;

/** Ordered list of every selectable profile, drives keyboard navigation. */
const ORDERED_PROFILES: FirmwareProfile[] = [
  FIRMWARE_PROFILE.LUMASYNC_V1,
  FIRMWARE_PROFILE.ADALIGHT,
];

interface ProfileTileProps {
  profile: FirmwareProfile;
  label: string;
  description: string;
  notice?: string;
  /** Localized "Detected: …" badge (only on the advertised tile). */
  advertisedBadge?: string;
  checked: boolean;
  /** True when the firmware health check disagrees with this tile. */
  mismatched: boolean;
  /** When true, the tile is treated as un-clickable + un-focusable. */
  disabled: boolean;
  /** Tooltip surfaced via `title` + `aria-describedby` on disabled tiles. */
  mismatchTooltip?: string;
  onSelect: (profile: FirmwareProfile) => void;
  onKeyNavigate: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  tileRef: React.RefObject<HTMLButtonElement | null>;
}

function ProfileTile({
  profile,
  label,
  description,
  notice,
  advertisedBadge,
  checked,
  mismatched,
  disabled,
  mismatchTooltip,
  onSelect,
  onKeyNavigate,
  tileRef,
}: ProfileTileProps) {
  const tooltipId = useId();
  const showTooltip = disabled && Boolean(mismatchTooltip);
  return (
    <>
      <button
        ref={tileRef}
        type="button"
        role="radio"
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        aria-describedby={showTooltip ? tooltipId : undefined}
        title={showTooltip ? mismatchTooltip : undefined}
        tabIndex={disabled ? -1 : checked ? 0 : -1}
        onClick={() => {
          if (disabled) return;
          onSelect(profile);
        }}
        onKeyDown={onKeyNavigate}
        data-profile={profile}
        data-mismatched={mismatched ? "true" : undefined}
        className={`lm-fw-tile${checked ? " is-on" : ""}${disabled ? " is-disabled" : ""}`}
        style={{
          all: "unset",
          cursor: disabled ? "not-allowed" : "pointer",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: "12px 14px",
          minHeight: 32,
          borderRadius: 8,
          border: `1px solid ${
            checked ? "rgba(255, 176, 32, 0.4)" : disabled ? "#1a1f27" : "#252b34"
          }`,
          background: checked
            ? "rgba(255, 176, 32, 0.08)"
            : disabled
              ? "#070a0d"
              : "#0a0c0f",
          color: disabled
            ? "#4d5564"
            : checked
              ? "var(--lm-amber, #ffb020)"
              : "#eaeef4",
          opacity: disabled ? 0.55 : 1,
          flex: 1,
          minWidth: 0,
        }}
      >
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            letterSpacing: "-0.005em",
            color: disabled
              ? "#4d5564"
              : checked
                ? "var(--lm-amber, #ffb020)"
                : "#eaeef4",
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontFamily:
              "var(--lm-mono, \"IBM Plex Mono\", ui-monospace, monospace)",
            fontSize: 10,
            color: disabled ? "#3d4452" : "#8a94a3",
            lineHeight: 1.45,
          }}
        >
          {description}
        </div>
        {advertisedBadge && (
          <div
            style={{
              fontFamily:
                "var(--lm-mono, \"IBM Plex Mono\", ui-monospace, monospace)",
              fontSize: 9.5,
              color: "var(--lm-green, #65d49a)",
              letterSpacing: "0.02em",
              marginTop: 2,
            }}
          >
            ● {advertisedBadge}
          </div>
        )}
        {notice && (
          <div
            style={{
              fontFamily:
                "var(--lm-mono, \"IBM Plex Mono\", ui-monospace, monospace)",
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
      {showTooltip && (
        <span id={tooltipId} hidden>
          {mismatchTooltip}
        </span>
      )}
    </>
  );
}

interface OverrideWarningDialogProps {
  advertised: FirmwareProfile;
  attempted: FirmwareProfile;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}

function OverrideWarningDialog({
  advertised,
  attempted,
  onConfirm,
  onCancel,
}: OverrideWarningDialogProps) {
  const { t } = useTranslation("common");
  const titleId = useId();
  const bodyId = useId();
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Focus trap + initial focus on Cancel (safer default).
  useEffect(() => {
    cancelRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key === "Enter") {
        // Enter without an explicit focus on Confirm should still cancel
        // (safer default — destructive action requires explicit click).
        // If Confirm is focused, the browser will fire its onClick anyway.
        if (document.activeElement === confirmRef.current) return;
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key === "Tab") {
        // 2-button trap: Tab cycles cancel ⇄ confirm.
        const root = dialogRef.current;
        if (!root) return;
        const focusables = [cancelRef.current, confirmRef.current].filter(
          (el): el is HTMLButtonElement => el !== null,
        );
        if (focusables.length === 0) return;
        const active = document.activeElement;
        const idx = focusables.findIndex((el) => el === active);
        const nextIdx = event.shiftKey
          ? (idx <= 0 ? focusables.length - 1 : idx - 1)
          : (idx === focusables.length - 1 ? 0 : idx + 1);
        event.preventDefault();
        focusables[nextIdx].focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
    };
  }, [onCancel]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid="lm-fw-override-dialog"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.55)",
        padding: 16,
      }}
      onClick={(e) => {
        // Backdrop click cancels.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="lm-settings-group"
        style={{
          maxWidth: 460,
          width: "100%",
          background: "var(--lm-panel, #0e1115)",
          borderRadius: 12,
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          border: "1px solid #252b34",
        }}
      >
        <div
          id={titleId}
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--lm-amber, #ffb020)",
          }}
        >
          {t("ledSettings.firmwareProfile.overrideWarningTitle")}
        </div>
        <div
          id={bodyId}
          style={{
            fontSize: 12,
            color: "var(--lm-ink-dim, #aab1bc)",
            lineHeight: 1.55,
          }}
        >
          {t("ledSettings.firmwareProfile.overrideWarningBody", {
            advertised,
            attempted,
          })}
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--lm-ink, #eaeef4)",
            cursor: "pointer",
            minHeight: 32,
          }}
        >
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(e) => setDontAskAgain(e.target.checked)}
            data-testid="lm-fw-override-dont-ask"
          />
          {t("ledSettings.firmwareProfile.overrideWarningDontAskAgain")}
        </label>
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 4,
          }}
        >
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            data-testid="lm-fw-override-cancel"
            style={{
              all: "unset",
              padding: "8px 14px",
              minHeight: 32,
              borderRadius: 6,
              border: "1px solid #252b34",
              background: "transparent",
              color: "var(--lm-ink, #eaeef4)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t("ledSettings.firmwareProfile.overrideWarningCancel")}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => onConfirm(dontAskAgain)}
            data-testid="lm-fw-override-confirm"
            style={{
              all: "unset",
              padding: "8px 14px",
              minHeight: 32,
              borderRadius: 6,
              border: "1px solid rgba(255, 176, 32, 0.45)",
              background: "rgba(255, 176, 32, 0.12)",
              color: "var(--lm-amber, #ffb020)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {t("ledSettings.firmwareProfile.overrideWarningConfirm", {
              attempted,
            })}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface FirmwareProfilePickerProps {
  /** Initial profile from shellStore — parent hydrates before first paint. */
  initialProfile?: FirmwareProfile;
  /**
   * Override hook: when supplied, the picker uses this advertised profile
   * instead of subscribing to `useDeviceConnection`. Tests use this to
   * keep the controller singleton out of the render tree; production
   * mounts leave it `undefined` so the picker subscribes itself.
   */
  advertisedFirmwareProfile?: FirmwareProfile;
  /**
   * Override hook: when supplied, the picker uses this initial value
   * instead of reading `dontWarnFirmwareProfileMismatch` from shellStore.
   * Tests use this to seed the persisted preference; production mounts
   * leave it `undefined` so the picker hydrates from disk.
   */
  initialDontWarnFirmwareProfileMismatch?: boolean;
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
  advertisedFirmwareProfile: advertisedFromProp,
  initialDontWarnFirmwareProfileMismatch,
  onProfileChange,
}: FirmwareProfilePickerProps) {
  const { t } = useTranslation("common");
  const [profile, setProfile] = useState<FirmwareProfile>(
    initialProfile ?? DEFAULT_PROFILE,
  );
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [dontWarn, setDontWarn] = useState<boolean>(
    initialDontWarnFirmwareProfileMismatch ?? false,
  );
  const [pendingMismatchedProfile, setPendingMismatchedProfile] = useState<
    FirmwareProfile | null
  >(null);

  // Subscribe to the device-connection controller so health-check updates
  // re-render the picker. Tests pass `advertisedFromProp` to bypass this.
  const deviceConnection = useDeviceConnection();
  const advertised: FirmwareProfile | undefined =
    advertisedFromProp ??
    deviceConnection.latestHealthCheck?.advertisedFirmwareProfile ??
    undefined;

  const v1Ref = useRef<HTMLButtonElement | null>(null);
  const adalightRef = useRef<HTMLButtonElement | null>(null);

  const tileRefs = useMemo(
    () => ({
      [FIRMWARE_PROFILE.LUMASYNC_V1]: v1Ref,
      [FIRMWARE_PROFILE.ADALIGHT]: adalightRef,
    }),
    [],
  );

  // Defensive hydrate when the parent does not supply `initialProfile`.
  useEffect(() => {
    let cancelled = false;
    if (initialProfile && initialDontWarnFirmwareProfileMismatch !== undefined) {
      return;
    }
    void shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        if (!initialProfile && state.firmwareProfile) {
          setProfile(state.firmwareProfile);
        }
        if (
          initialDontWarnFirmwareProfileMismatch === undefined &&
          typeof state.dontWarnFirmwareProfileMismatch === "boolean"
        ) {
          setDontWarn(state.dontWarnFirmwareProfileMismatch);
        }
      })
      .catch((error) => {
        console.error(
          "[LumaSync] FirmwareProfilePicker hydrate failed:",
          error,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [initialProfile, initialDontWarnFirmwareProfileMismatch]);

  /** Commit a profile selection to shellStore + notify parent. */
  const commitProfile = useCallback(
    (next: FirmwareProfile) => {
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
    [onProfileChange],
  );

  const isMismatch = useCallback(
    (candidate: FirmwareProfile): boolean =>
      advertised !== undefined && advertised !== candidate,
    [advertised],
  );

  const tileDisabled = useCallback(
    (candidate: FirmwareProfile): boolean =>
      isMismatch(candidate) && !overrideEnabled,
    [isMismatch, overrideEnabled],
  );

  const handleSelect = useCallback(
    (next: FirmwareProfile) => {
      if (next === profile) return;
      // Disabled tile: ignore (the click handler short-circuits, but the
      // keyboard handler routes through here too).
      if (tileDisabled(next)) return;

      // Mismatched commit via the override path → warning dialog unless
      // the user previously dismissed it.
      if (isMismatch(next) && !dontWarn) {
        setPendingMismatchedProfile(next);
        return;
      }
      commitProfile(next);
    },
    [commitProfile, dontWarn, isMismatch, profile, tileDisabled],
  );

  const handleDialogConfirm = useCallback(
    (dontAskAgain: boolean) => {
      const target = pendingMismatchedProfile;
      setPendingMismatchedProfile(null);
      if (!target) return;
      if (dontAskAgain) {
        setDontWarn(true);
        void shellStore
          .save({ dontWarnFirmwareProfileMismatch: true })
          .catch((error) => {
            console.error(
              "[LumaSync] shellStore.save(dontWarnFirmwareProfileMismatch) failed:",
              error,
            );
          });
      }
      commitProfile(target);
    },
    [commitProfile, pendingMismatchedProfile],
  );

  const handleDialogCancel = useCallback(() => {
    setPendingMismatchedProfile(null);
  }, []);

  /** Resolve the next selectable tile that the keyboard should land on. */
  const findNextEnabledProfile = useCallback(
    (current: FirmwareProfile, direction: 1 | -1): FirmwareProfile => {
      const idx = ORDERED_PROFILES.indexOf(current);
      const len = ORDERED_PROFILES.length;
      for (let step = 1; step <= len; step++) {
        const candidate = ORDERED_PROFILES[(idx + direction * step + len * len) % len];
        if (!tileDisabled(candidate)) return candidate;
      }
      // Every tile is disabled (advertised set + override off in a future
      // 3-tile world). Stay put.
      return current;
    },
    [tileDisabled],
  );

  const handleKeyNavigate = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const direction =
        event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -1
            : 0;
      if (direction === 0) return;
      event.preventDefault();
      const nextProfile = findNextEnabledProfile(profile, direction);
      if (nextProfile === profile) return;
      handleSelect(nextProfile);
      tileRefs[nextProfile].current?.focus();
    },
    [findNextEnabledProfile, handleSelect, profile, tileRefs],
  );

  // Persist the override toggle locally — no shellStore field for this
  // intentionally. Power-user override must be re-armed each session so
  // accidental future mismatched commits still go through the gate.
  const handleOverrideToggle = useCallback((next: boolean) => {
    setOverrideEnabled(next);
  }, []);

  const showOverrideAffordance = advertised !== undefined;
  const overrideToggleId = useId();

  return (
    <section className="lm-settings-group">
      <div className="lm-settings-group-h">
        <span className="t">{t("ledSettings.firmwareProfile.title")}</span>
        <span className="sub">
          {t("ledSettings.firmwareProfile.description")}
        </span>
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
        {ORDERED_PROFILES.map((p) => {
          const checked = profile === p;
          const mismatched = isMismatch(p);
          const disabled = tileDisabled(p);
          const isAdvertised = advertised === p;
          const labelKey =
            p === FIRMWARE_PROFILE.LUMASYNC_V1
              ? "ledSettings.firmwareProfile.lumasyncV1Label"
              : "ledSettings.firmwareProfile.adalightLabel";
          const descriptionKey =
            p === FIRMWARE_PROFILE.LUMASYNC_V1
              ? "ledSettings.firmwareProfile.lumasyncV1Description"
              : "ledSettings.firmwareProfile.adalightDescription";
          return (
            <ProfileTile
              key={p}
              profile={p}
              label={t(labelKey)}
              description={t(descriptionKey)}
              checked={checked}
              mismatched={mismatched}
              disabled={disabled}
              advertisedBadge={
                isAdvertised
                  ? t("ledSettings.firmwareProfile.advertisedBadge", {
                      advertised: advertised,
                    })
                  : undefined
              }
              mismatchTooltip={
                mismatched && advertised !== undefined
                  ? t("ledSettings.firmwareProfile.mismatchTooltip", {
                      advertised,
                      attempted: p,
                    })
                  : undefined
              }
              notice={
                checked && p === FIRMWARE_PROFILE.ADALIGHT
                  ? t(
                      "ledSettings.firmwareProfile.brightnessDisabledTooltip",
                    )
                  : undefined
              }
              onSelect={handleSelect}
              onKeyNavigate={handleKeyNavigate}
              tileRef={tileRefs[p]}
            />
          );
        })}
      </div>

      {showOverrideAffordance && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 14px 12px",
            fontSize: 11,
            color: "var(--lm-ink-dim, #aab1bc)",
            minHeight: 32,
          }}
        >
          <input
            id={overrideToggleId}
            type="checkbox"
            checked={overrideEnabled}
            onChange={(e) => handleOverrideToggle(e.target.checked)}
            data-testid="lm-fw-use-anyway"
          />
          <label htmlFor={overrideToggleId} style={{ cursor: "pointer" }}>
            <span style={{ fontWeight: 600 }}>
              {t("ledSettings.firmwareProfile.useAnywayLabel")}
            </span>
            <span style={{ marginLeft: 6, color: "#6c7585" }}>
              {t("ledSettings.firmwareProfile.useAnywayHint")}
            </span>
          </label>
        </div>
      )}

      {pendingMismatchedProfile && advertised && (
        <OverrideWarningDialog
          advertised={advertised}
          attempted={pendingMismatchedProfile}
          onConfirm={handleDialogConfirm}
          onCancel={handleDialogCancel}
        />
      )}
    </section>
  );
}
