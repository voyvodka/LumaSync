import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { FurniturePlacement } from "../../../../shared/contracts/roomMap";

const FURNITURE_TYPES: FurniturePlacement["type"][] = ["sofa", "table", "chair", "other"];

interface LeftToolbarProps {
  hasTv: boolean;
  onAddTv: () => void;
  onAddFurniture: (type: FurniturePlacement["type"]) => void;
  onAddUsb: () => void;
  onAddHue: () => void;
  onAddImage: () => void;
}

function IconTv() {
  return (
    <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="16" height="11" rx="1.5" />
      <path d="M7 17h6M10 14v3" />
    </svg>
  );
}

function IconFurniture() {
  return (
    <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10v5h14v-5" />
      <path d="M5 10V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3" />
      <path d="M3 15v2M17 15v2" />
    </svg>
  );
}

function IconLed() {
  return (
    <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10h14" strokeDasharray="2 3" />
      <circle cx="3" cy="10" r="1.5" fill="currentColor" />
      <circle cx="17" cy="10" r="1.5" fill="currentColor" />
    </svg>
  );
}

function IconHue() {
  return (
    <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="10" r="4" />
      <path d="M10 2v3M10 15v3M2 10h3M15 10h3" />
    </svg>
  );
}

function IconImage() {
  return (
    <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="16" height="14" rx="1.5" />
      <circle cx="7" cy="8" r="1.5" />
      <path d="M18 14l-4-4-3 3-2-2-7 6" />
    </svg>
  );
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
      className={`group/chip relative flex items-center justify-center w-7 h-7 rounded bg-black/60 backdrop-blur-sm transition-colors ${
        disabled
          ? "opacity-40 cursor-not-allowed text-white/50"
          : "text-white/90 hover:bg-black/80 active:bg-black/90"
      }`}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
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
  onAddHue,
  onAddImage,
}: LeftToolbarProps) {
  const { t } = useTranslation("common");
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
        label={t("roomMap.toolbar.addTv")}
        onClick={onAddTv}
        disabled={hasTv}
      />

      <div ref={btnRef} className="relative">
        <ToolChip
          icon={<IconFurniture />}
          label={t("roomMap.toolbar.addFurniture")}
          onClick={() => setFurnitureOpen((v) => !v)}
        />
        {furnitureOpen && (
          <div
            ref={dropdownRef}
            className="absolute left-full top-0 ml-1.5 min-w-[100px] rounded-md border border-zinc-700 bg-zinc-900 shadow-lg z-50 py-1"
          >
            {FURNITURE_TYPES.map((type) => (
              <button
                key={type}
                className="w-full text-left px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
                onClick={() => { onAddFurniture(type); close(); }}
              >
                {t(`roomMap.furniture.type.${type}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      <ToolChip
        icon={<IconLed />}
        label={t("roomMap.toolbar.addUsb")}
        onClick={onAddUsb}
      />

      <ToolChip
        icon={<IconHue />}
        label={t("roomMap.toolbar.addHue")}
        onClick={onAddHue}
      />

      <ToolChip
        icon={<IconImage />}
        label={t("roomMap.toolbar.addImage")}
        onClick={onAddImage}
      />
    </div>
  );
}
