import { useId } from "react";
import { useTranslation } from "react-i18next";

import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import { RowButton, RowNote, SettingRow } from "@/shared/ui/SettingRow/SettingRow";
import pageStyles from "@/shared/ui/SettingRow/SettingPage.module.css";

interface HueAddressRowProps {
  hue: UseHueOnboardingResult;
  /** A bridge discovery missed, or the address a known bridge moved to. */
  hint: string;
}

/** The typed-address path: first contact with a bridge discovery missed, or where a known one moved. */
export function HueAddressRow({ hue, hint }: HueAddressRowProps) {
  const { t } = useTranslation();
  const errorId = useId();
  const { manualIp, manualIpError, isDiscovering, setManualIp, submitManualIp } = hue;
  const disabled = isDiscovering || !manualIp || Boolean(manualIpError);

  return (
    <SettingRow
      label={t("hue:row.address")}
      hint={hint}
      control={
        <>
          <input
            className={pageStyles.input}
            value={manualIp}
            onChange={(e) => {
              setManualIp(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !disabled) {
                e.preventDefault();
                void submitManualIp();
              }
            }}
            placeholder={t("hue:manualIp.placeholder")}
            aria-label={t("hue:manualIp.inputLabel")}
            aria-describedby={manualIpError ? errorId : undefined}
            aria-invalid={manualIpError ? true : undefined}
            spellCheck={false}
            autoComplete="off"
          />
          <RowButton
            onClick={() => {
              void submitManualIp();
            }}
            disabled={disabled}
            aria-busy={isDiscovering || undefined}
          >
            {t("hue:page.enterIp")}
          </RowButton>
        </>
      }
    >
      {manualIpError ? (
        <RowNote tone="error">
          <span id={errorId}>{t(manualIpError)}</span>
        </RowNote>
      ) : null}
    </SettingRow>
  );
}
