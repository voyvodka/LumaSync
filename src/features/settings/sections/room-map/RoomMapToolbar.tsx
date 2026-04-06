import { useRef, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { FurniturePlacement } from "../../../../shared/contracts/roomMap";

function IconGear() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" />
    </svg>
  );
}

interface RoomMapToolbarProps {
  hasTv: boolean;
  onAddTv: () => void;
  onAddFurniture: (type: FurniturePlacement["type"]) => void;
  onAddUsb: () => void;
  onAddHue: () => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
}

const FURNITURE_TYPES: FurniturePlacement["type"][] = ["sofa", "table", "chair", "other"];

export function RoomMapToolbar({
  hasTv,
  onAddTv,
  onAddFurniture,
  onAddUsb,
  onAddHue,
  settingsOpen,
  onToggleSettings,
}: RoomMapToolbarProps) {
  const { t } = useTranslation("common");
  const [furnitureDropdownOpen, setFurnitureDropdownOpen] = useState(false);
  const furnitureBtnRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const closeFurnitureDropdown = useCallback(() => {
    setFurnitureDropdownOpen(false);
  }, []);

  useEffect(() => {
    if (!furnitureDropdownOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeFurnitureDropdown();
        furnitureBtnRef.current?.focus();
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        !furnitureBtnRef.current?.contains(e.target as Node)
      ) {
        closeFurnitureDropdown();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [furnitureDropdownOpen, closeFurnitureDropdown]);

  const handleFurnitureSelect = (type: FurniturePlacement["type"]) => {
    onAddFurniture(type);
    closeFurnitureDropdown();
  };

  const btnBase =
    "px-2 py-1 text-[11px] font-semibold rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60";
  const btnActive =
    "text-slate-700 hover:bg-slate-100 hover:text-slate-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100";

  return (
    <div className="relative h-10 flex items-center gap-2 px-3 border-b border-slate-200/70 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 shrink-0">
      {/* Add TV */}
      <button
        className={`${btnBase} ${
          hasTv
            ? "opacity-40 cursor-not-allowed text-slate-500 dark:text-zinc-500"
            : btnActive
        }`}
        onClick={hasTv ? undefined : onAddTv}
        disabled={hasTv}
        title={hasTv ? t("roomMap.toolbar.tvAlreadyPlaced") : undefined}
        aria-disabled={hasTv}
      >
        {t("roomMap.toolbar.addTv")}
      </button>

      {/* Add Furniture with dropdown */}
      <div className="relative">
        <button
          ref={furnitureBtnRef}
          className={`${btnBase} ${btnActive}`}
          onClick={() => setFurnitureDropdownOpen((v) => !v)}
          aria-expanded={furnitureDropdownOpen}
          aria-haspopup="listbox"
        >
          {t("roomMap.toolbar.addFurniture")}
        </button>
        {furnitureDropdownOpen && (
          <div
            ref={dropdownRef}
            className="absolute top-full left-0 mt-1 w-32 rounded-md border border-slate-200/70 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-lg z-50 py-1"
            role="listbox"
          >
            {FURNITURE_TYPES.map((type) => (
              <button
                key={type}
                className="w-full text-left px-3 py-1.5 text-sm text-slate-700 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 focus-visible:outline-none focus-visible:bg-slate-100 dark:focus-visible:bg-zinc-800"
                role="option"
                onClick={() => handleFurnitureSelect(type)}
              >
                {t(`roomMap.furniture.type.${type}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Add USB */}
      <button className={`${btnBase} ${btnActive}`} onClick={onAddUsb}>
        {t("roomMap.toolbar.addUsb")}
      </button>

      {/* Add Hue */}
      <button className={`${btnBase} ${btnActive}`} onClick={onAddHue}>
        {t("roomMap.toolbar.addHue")}
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Settings gear */}
      <button
        className={`${btnBase} ${
          settingsOpen
            ? "bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-zinc-100"
            : btnActive
        } flex items-center gap-1 min-w-[32px] min-h-[32px] justify-center`}
        onClick={onToggleSettings}
        aria-label={t("roomMap.toolbar.settingsAriaLabel")}
        aria-pressed={settingsOpen}
      >
        <IconGear />
      </button>
    </div>
  );
}
