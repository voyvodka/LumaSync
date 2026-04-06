import { useTranslation } from "react-i18next";

export function RoomMapEmptyHint() {
  const { t } = useTranslation("common");

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
      <p className="text-sm font-semibold text-slate-700 dark:text-zinc-300">
        {t("roomMap.empty.heading")}
      </p>
      <p className="text-xs text-slate-400 dark:text-zinc-500 max-w-xs text-center">
        {t("roomMap.empty.body")}
      </p>
    </div>
  );
}
