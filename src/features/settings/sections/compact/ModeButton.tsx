import type { LightingModeKind } from "@/features/mode/model/contracts";

interface ModeButtonProps {
  kind: LightingModeKind;
  active: boolean;
  disabled: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: (kind: LightingModeKind) => void;
}

export function ModeButton({ kind, active, disabled, label, icon, onClick }: ModeButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onClick(kind)}
      className={`lm-compact-mbtn ${active ? "is-on" : ""}`}
      aria-pressed={active}
      data-testid={`mode-button-${kind}`}
    >
      <span className="ico">{icon}</span>
      <span className="tn">{label}</span>
    </button>
  );
}
