/**
 * UIModeToggle — small floating icon button for switching between the
 * compact and full UI layouts. Rendered inside the app content (below the
 * native title bar), absolutely positioned in the top-right corner.
 *
 * The native OS title bar owns window-level concerns (drag, traffic
 * lights, app title, double-click zoom). This button is purely an
 * in-content affordance for swapping layouts.
 */

import { useTranslation } from "react-i18next";

type ToggleVariant = "to-full" | "to-compact";

interface UIModeToggleProps {
  variant: ToggleVariant;
  onClick: () => void;
}

export function UIModeToggle({ variant, onClick }: UIModeToggleProps) {
  const { t } = useTranslation("common");
  const title = t(
    variant === "to-full" ? "settings.switchToFull" : "settings.switchToCompact",
  );

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="absolute top-2 right-2 z-20 rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
    >
      {variant === "to-full" ? <ExpandIcon /> : <CollapseIcon />}
    </button>
  );
}

function ExpandIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 6V1h5M15 10v5h-5M1 10v5h5M15 6V1h-5" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 1v4H1M12 15v-4h3M1 12h4v3M15 4h-4V1" />
    </svg>
  );
}
