import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { FurniturePlacement } from "@/shared/contracts/roomMap";
import { IconTv, IconFurniture, IconLed, IconImage } from "@/shared/ui/icons";

const FURNITURE_TYPES: FurniturePlacement["type"][] = ["sofa", "table", "chair", "other"];

interface LeftToolbarProps {
  hasTv: boolean;
  onAddTv: () => void;
  onAddFurniture: (type: FurniturePlacement["type"]) => void;
  onAddUsb: () => void;
  onAddImage: () => void;
}

function ToolChip({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className={`group/chip relative flex items-center justify-center w-8 h-8 rounded bg-black/60 backdrop-blur-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lm-amber)]/60 ${
        disabled
          ? "opacity-40 cursor-not-allowed text-white/50"
          : "text-white/90 hover:bg-black/80 active:bg-black/90"
      }`}
      aria-label={label}
      title={label}
      onClick={(e) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        onClick();
      }}
      aria-disabled={disabled}
    >
      <span className="flex items-center justify-center shrink-0">{icon}</span>
      {/* Hover label — slides out to the right */}
      <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-0 opacity-0 scale-x-0 origin-left group-hover/chip:ml-1.5 group-hover/chip:opacity-100 group-hover/chip:scale-x-100 transition-all duration-150 ease-out whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-medium text-white/90">
        {label}
      </span>
    </button>
  );
}

export function LeftToolbar({
  hasTv,
  onAddTv,
  onAddFurniture,
  onAddUsb,
  onAddImage,
}: LeftToolbarProps) {
  const { t } = useTranslation();
  const [furnitureOpen, setFurnitureOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setFurnitureOpen(false), []);

  useEffect(() => {
    if (!furnitureOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) close();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("mousedown", handleClick); document.removeEventListener("keydown", handleKey); };
  }, [furnitureOpen, close]);

  return (
    <div className="absolute top-2 left-2 z-50 flex flex-col gap-1 pointer-events-auto">
      <ToolChip
        icon={<IconTv />}
        label={t("roomMap:toolbar.addTv")}
        onClick={onAddTv}
        disabled={hasTv}
      />

      <div ref={btnRef} className="relative">
        <ToolChip
          icon={<IconFurniture />}
          label={t("roomMap:toolbar.addFurniture")}
          onClick={() => setFurnitureOpen((v) => !v)}
        />
        {furnitureOpen && (
          <div
            ref={dropdownRef}
            className="lm-room-toolchip-menu"
            role="menu"
          >
            {FURNITURE_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                role="menuitem"
                className="lm-room-toolchip-menu-item"
                onClick={() => { onAddFurniture(type); close(); }}
              >
                {t(`roomMap:furniture.type.${type}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      <ToolChip
        icon={<IconLed />}
        label={t("roomMap:toolbar.addUsb")}
        onClick={onAddUsb}
      />

      <ToolChip
        icon={<IconImage />}
        label={t("roomMap:toolbar.addImage")}
        onClick={onAddImage}
      />
    </div>
  );
}
