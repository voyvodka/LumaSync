import type { LightingModeKind } from "@/shared/contracts/mode";

interface ModeButtonProps {
  kind: LightingModeKind;
  active: boolean;
  disabled: boolean;
  label: string;
  /** Set for a brand label such as "Ambilight", which the uppercase style would
   * otherwise case by Turkish rules ("AMBİLİGHT") under `lang="tr"`. */
  labelLang?: string;
  icon: React.ReactNode;
  onClick: (kind: LightingModeKind) => void;
}

export function ModeButton({ kind, active, disabled, label, labelLang, icon, onClick }: ModeButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onClick(kind)}
      className="lm-compact-mbtn"
      aria-pressed={active}
      data-testid={`mode-button-${kind}`}
    >
      <span className="ico">{icon}</span>
      <span className="tn" lang={labelLang}>{label}</span>
    </button>
  );
}
