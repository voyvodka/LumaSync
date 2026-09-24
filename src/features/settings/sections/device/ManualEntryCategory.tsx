import { useTranslation } from "react-i18next";

import { EmptyState } from "@/shared/ui/EmptyState";

export interface ManualEntryCategoryProps {
  isActive: boolean;
}

export function ManualEntryCategory({ isActive }: ManualEntryCategoryProps) {
  const { t } = useTranslation();

  return (
    <div className="lm-device-cat-body" hidden={!isActive}>
      <div className="lm-device-head">
        <div>
          <h1>{t("device:page.header.manualTitle")}</h1>
          <div className="lm-device-head-sub">{t("device:page.header.manualSub")}</div>
        </div>
      </div>
      <EmptyState body={t("device:page.manual.body")} />
    </div>
  );
}
