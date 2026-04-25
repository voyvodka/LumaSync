/**
 * OnboardingBanner — v1.5 W2-B3
 *
 * Reusable progressive-hint banner extracted from the
 * `lm-lights-cal-banner` pattern that originally lived in
 * `LightsSection.tsx`. The visual language (dark amber stripe, amber
 * uppercase title, dim sublabel, amber pill action) is preserved so the
 * existing calibration banner can be migrated as a drop-in.
 *
 * Why a generic component:
 *   - The first-run onboarding flow (W2-B4) needs to mount three of
 *     these banners across LIGHTS / DEVICES / LED_SETUP sections, each
 *     with a different copy + action pair. Inlining the JSX three times
 *     would drift visual style and a11y semantics.
 *   - Future progressive hints (e.g. "no Hue area selected", "calibration
 *     drift detected") get a single surface to land on instead of
 *     spawning new banner classes.
 *
 * A11y:
 *   - `role="region"` + `aria-label` so a screen reader user can jump
 *     straight to the hint as a landmark.
 *   - Optional step indicator (`step` / `totalSteps`) renders a `1/3`
 *     monospace pill on the left edge — purely decorative; the
 *     accessible label still reads naturally because `role="region"`
 *     uses `aria-label` not visible-text concatenation.
 *   - Dismiss × button gets a localized `aria-label`, focus-visible
 *     amber ring, ≥32 px tap target, and is the last focusable element
 *     in the banner so it never traps keyboard users on entry.
 *   - The transition on the dismiss button is wrapped in
 *     `prefers-reduced-motion`.
 *
 * Migration note: existing `.lm-lights-cal-banner` consumers map 1:1 —
 * `title` ⇒ `.ttl`, `body` ⇒ `.sub`, `primaryAction` ⇒ `.act`. Pure
 * migration, no behavior change.
 */
import { useTranslation } from "react-i18next";

export interface OnboardingBannerAction {
  /** Visible label rendered inside the amber pill. */
  label: string;
  /** Click / Enter handler — keyboard-equivalent to a click. */
  onClick: () => void;
  /**
   * Optional aria-label override. Defaults to `label` so most callers
   * never need to set this.
   */
  ariaLabel?: string;
}

export interface OnboardingBannerProps {
  /** Uppercase amber heading — short, e.g. "Calibration required". */
  title: string;
  /** Plain dim-ink body copy explaining what to do. */
  body: string;
  /**
   * 1-based current step (e.g. `2`). When omitted the step pill is
   * hidden and the banner reads as a stand-alone hint.
   */
  step?: number;
  /**
   * Total step count — pairs with `step` to render `2/3`. Required when
   * `step` is set, ignored otherwise.
   */
  totalSteps?: number;
  /** Primary call-to-action — usually a navigation deep-link. */
  primaryAction?: OnboardingBannerAction;
  /**
   * Optional secondary action (e.g. "Skip"). Rendered as a plain text
   * button with no amber fill so it sits visually below the primary.
   */
  secondaryAction?: OnboardingBannerAction;
  /**
   * Dismiss handler. When omitted, the × button is hidden — the banner
   * becomes a permanent hint (calibration banner today).
   */
  onDismiss?: () => void;
  /**
   * Override the wrapping landmark's `aria-label`. Defaults to `title`
   * so screen readers always announce a meaningful name.
   */
  ariaLabel?: string;
  /**
   * Hint about how live the banner is. Pass `"polite"` (default) for
   * onboarding flow steps so a screen reader user is informed when the
   * step advances. Calibration banner stays `"polite"` too — it never
   * appears unannounced.
   */
  ariaLive?: "polite" | "off";
}

export function OnboardingBanner({
  title,
  body,
  step,
  totalSteps,
  primaryAction,
  secondaryAction,
  onDismiss,
  ariaLabel,
  ariaLive = "polite",
}: OnboardingBannerProps) {
  const { t } = useTranslation("common");
  const showStepPill =
    typeof step === "number" && typeof totalSteps === "number" && totalSteps > 0;

  return (
    <div
      className="lm-onboarding-banner"
      role="region"
      aria-label={ariaLabel ?? title}
      aria-live={ariaLive}
    >
      {showStepPill && (
        <span
          className="lm-onboarding-banner-step"
          aria-hidden="true"
          // Decorative — the surrounding region's aria-label already
          // names the banner; announcing "2/3" verbatim would clutter.
        >
          {step}/{totalSteps}
        </span>
      )}
      <div className="lm-onboarding-banner-text">
        <div className="ttl">{title}</div>
        <div className="sub">{body}</div>
      </div>
      {(primaryAction || secondaryAction) && (
        <div className="lm-onboarding-banner-actions">
          {secondaryAction && (
            <button
              type="button"
              className="lm-onboarding-banner-secondary"
              onClick={secondaryAction.onClick}
              aria-label={secondaryAction.ariaLabel ?? secondaryAction.label}
            >
              {secondaryAction.label}
            </button>
          )}
          {primaryAction && (
            <button
              type="button"
              className="lm-onboarding-banner-primary"
              onClick={primaryAction.onClick}
              aria-label={primaryAction.ariaLabel ?? primaryAction.label}
            >
              {primaryAction.label}
            </button>
          )}
        </div>
      )}
      {onDismiss && (
        <button
          type="button"
          className="lm-onboarding-banner-dismiss"
          onClick={onDismiss}
          aria-label={t("ui.onboardingBanner.dismissAriaLabel")}
          title={t("ui.onboardingBanner.dismissAriaLabel")}
        >
          <DismissIcon />
        </button>
      )}
    </div>
  );
}

function DismissIcon() {
  return (
    <svg
      viewBox="0 0 12 12"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="3" y1="3" x2="9" y2="9" />
      <line x1="9" y1="3" x2="3" y2="9" />
    </svg>
  );
}
