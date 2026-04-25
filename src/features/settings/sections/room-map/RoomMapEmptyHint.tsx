import { useTranslation } from "react-i18next";

export function RoomMapEmptyHint() {
  const { t } = useTranslation("common");

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
      <p className="text-sm font-semibold text-zinc-200">
        {t("roomMap.empty.heading")}
      </p>
      <p className="text-xs text-zinc-500 max-w-xs text-center">
        {t("roomMap.empty.body")}
      </p>
    </div>
  );
}
