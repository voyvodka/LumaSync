import { useTranslation } from "react-i18next";

export interface ManualEntryCategoryProps {
  isActive: boolean;
}

export function ManualEntryCategory({ isActive }: ManualEntryCategoryProps) {
  const { t } = useTranslation();

  return (
    <div className={isActive ? "lm-device-cat-body" : "lm-device-cat-body hidden"} hidden={!isActive}>
      <div className="lm-device-head">
        <div>
          <h1>{t("device:page.header.manualTitle")}</h1>
          <div className="lm-device-head-sub">{t("device:page.header.manualSub")}</div>
        </div>
      </div>
      <div className="lm-device-empty">
        <p>{t("device:page.manual.body")}</p>
      </div>
    </div>
  );
}
