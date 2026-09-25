import { useId } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "@/features/i18n/catalogue";
import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import { cx } from "@/shared/ui/cx";

interface HueManualIpFormProps {
  hue: UseHueOnboardingResult;
  title: TranslationKey;
  description: TranslationKey;
  /** Drawn inside a bridge card rather than as a card of its own. */
  inset?: boolean;
}

/** The typed-address path: first contact with a bridge discovery missed, or
 *  the address a known bridge moved to. */
export function HueManualIpForm({ hue, title, description, inset = false }: HueManualIpFormProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const { manualIp, manualIpError, isDiscovering, setManualIp, submitManualIp } = hue;
  const disabled = isDiscovering || !manualIp || Boolean(manualIpError);
  const descriptionId = `${fieldId}-description`;
  const errorId = `${fieldId}-error`;

  return (
    <div className={cx("lm-hue-ip-form", inset && "is-inset")}>
      <div>
        <div className="lm-hue-ip-form-title">{t(title)}</div>
        <div className="lm-hue-ip-form-sub" id={descriptionId}>{t(description)}</div>
      </div>
      <div className="lm-hue-ip-row">
        <input
          className="lm-hue-ip-input"
          value={manualIp}
          onChange={(e) => { setManualIp(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !disabled) {
              e.preventDefault();
              void submitManualIp();
            }
          }}
          placeholder={t("hue:manualIp.placeholder")}
          aria-label={t("hue:manualIp.inputLabel")}
          aria-describedby={manualIpError ? `${descriptionId} ${errorId}` : descriptionId}
          aria-invalid={manualIpError ? true : undefined}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          className="lm-hue-ip-submit"
          onClick={() => { void submitManualIp(); }}
          disabled={disabled}
        >
          {t("hue:page.enterIp")}
        </button>
      </div>
      {manualIpError ? <div className="lm-hue-ip-error" id={errorId}>{t(manualIpError)}</div> : null}
    </div>
  );
}
