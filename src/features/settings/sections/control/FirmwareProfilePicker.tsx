/**
 * FirmwareProfilePicker — serial protocol toggle.
 *
 * A 2-tile radio group that lets the user choose between the LumaSync v1
 * protocol (handshake + telemetry) and Adalight (plain interoperability
 * for Prismatik / Hyperion / Boblight / DIY Arduino). Selection is
 * persisted to `shellStore.firmwareProfile`; when Adalight is active the
 * brightness slider in `SolidColorPanel` is locked because the Adalight
 * wire format has brightness baked into the firmware.
 *
 * Bug H4 — when the last serial health check reported a definite
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
 *   - Override dialog: the shared `ConfirmDialog` — focus trap, ESC =
 *     cancel, and Enter cancels unless Confirm itself has focus.
 *   - Tap targets ≥ 32 px (tile padding 12+12=24 + content height ≥ 8).
 *   - Forced-colors / reduced-motion respected via the shared
 *     `lm-strip-tile` rules in `src/styles/strip-settings.css`.
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

import type { TranslationKey } from "@/features/i18n/catalogue";
import {
  FIRMWARE_PROFILE,
  type FirmwareProfile,
} from "@/shared/contracts/device";
import { useAdvertisedFirmwareProfile } from "@/features/device/useAdvertisedFirmwareProfile";
import { shellStore } from "@/features/persistence/shellStore";
import { ConfirmDialog } from "@/shared/ui/ConfirmDialog";
import { Toggle } from "@/shared/ui/Toggle";

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
        className="lm-strip-tile"
      >
        <span className="lm-strip-tile-name">{label}</span>
        <span className="lm-strip-tile-desc">{description}</span>
        {advertisedBadge ? (
          <span className="lm-strip-tile-note is-ok">
            <span aria-hidden="true">● </span>
            {advertisedBadge}
          </span>
        ) : null}
        {notice ? (
          <span className="lm-strip-tile-note is-warn">
            <span aria-hidden="true">⚠ </span>
            {notice}
          </span>
        ) : null}
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
  const { t } = useTranslation();
  const [dontAskAgain, setDontAskAgain] = useState(false);

  // Enter is NOT "confirm" here. The dialog guards a destructive override, so
  // the only way through it is an explicit click or Enter on a focused Confirm
  // — anything else cancels (`enterCancels`).
  return (
    <ConfirmDialog
      title={t("lights:led.firmwareProfile.overrideWarningTitle")}
      body={t("lights:led.firmwareProfile.overrideWarningBody", { advertised, attempted })}
      confirmLabel={t("lights:led.firmwareProfile.overrideWarningConfirm", { attempted })}
      cancelLabel={t("lights:led.firmwareProfile.overrideWarningCancel")}
      onConfirm={() => onConfirm(dontAskAgain)}
      onCancel={onCancel}
      enterCancels
      testId="lm-fw-override-dialog"
      confirmTestId="lm-fw-override-confirm"
      cancelTestId="lm-fw-override-cancel"
    >
      <label className="flex min-h-8 cursor-pointer items-center gap-2 text-xs text-ink">
        <input
          type="checkbox"
          checked={dontAskAgain}
          onChange={(e) => setDontAskAgain(e.target.checked)}
          data-testid="lm-fw-override-dont-ask"
        />
        {t("lights:led.firmwareProfile.overrideWarningDontAskAgain")}
      </label>
    </ConfirmDialog>
  );
}

export interface FirmwareProfilePickerProps {
  /** Initial profile from shellStore — parent hydrates before first paint. */
  initialProfile?: FirmwareProfile;
  /**
   * Override hook: when supplied, the picker uses this advertised profile
   * instead of subscribing to `useAdvertisedFirmwareProfile`. Tests use
   * this to bypass the event bus; production mounts leave it `undefined`
   * so the picker subscribes itself.
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
  const { t } = useTranslation();
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

  // Read-only subscription to the last completed health check anywhere in
  // the app — no controller mount, no port scan. Tests pass
  // `advertisedFromProp` to bypass this.
  const advertisedFromBus = useAdvertisedFirmwareProfile();
  const advertised: FirmwareProfile | undefined = advertisedFromProp ?? advertisedFromBus;

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
        if (candidate !== undefined && !tileDisabled(candidate)) return candidate;
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
  const overrideHintId = useId();
  const titleId = useId();

  return (
    <div className="lm-strip-setting" role="group" aria-labelledby={titleId}>
      <h3 className="lm-strip-setting-h" id={titleId}>{t("lights:led.firmwareProfile.title")}</h3>
      <p className="lm-strip-setting-desc">{t("lights:led.firmwareProfile.description")}</p>
      <div
        role="radiogroup"
        aria-label={t("lights:led.firmwareProfile.title")}
        className="lm-strip-tiles"
      >
        {ORDERED_PROFILES.map((p) => {
          const checked = profile === p;
          const mismatched = isMismatch(p);
          const disabled = tileDisabled(p);
          const isAdvertised = advertised === p;
          const labelKey: TranslationKey =
            p === FIRMWARE_PROFILE.LUMASYNC_V1
              ? "lights:led.firmwareProfile.lumasyncV1Label"
              : "lights:led.firmwareProfile.adalightLabel";
          const descriptionKey: TranslationKey =
            p === FIRMWARE_PROFILE.LUMASYNC_V1
              ? "lights:led.firmwareProfile.lumasyncV1Description"
              : "lights:led.firmwareProfile.adalightDescription";
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
                  ? t("lights:led.firmwareProfile.advertisedBadge", {
                      advertised: advertised,
                    })
                  : undefined
              }
              mismatchTooltip={
                mismatched && advertised !== undefined
                  ? t("lights:led.firmwareProfile.mismatchTooltip", {
                      advertised,
                      attempted: p,
                    })
                  : undefined
              }
              notice={
                checked && p === FIRMWARE_PROFILE.ADALIGHT
                  ? t(
                      "lights:led.firmwareProfile.brightnessDisabledTooltip",
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
        <div className="lm-strip-setting-check">
          <p className="lm-strip-setting-check-tx">
            <b>{t("lights:led.firmwareProfile.useAnywayLabel")}</b>{" "}
            <span id={overrideHintId}>{t("lights:led.firmwareProfile.useAnywayHint")}</span>
          </p>
          <Toggle
            checked={overrideEnabled}
            onChange={handleOverrideToggle}
            label={t("lights:led.firmwareProfile.useAnywayLabel")}
            aria-describedby={overrideHintId}
            data-testid="lm-fw-use-anyway"
          />
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
    </div>
  );
}
