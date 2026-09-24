import type { ButtonHTMLAttributes, ReactNode } from "react";

type NativeButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type" | "role" | "onChange" | "onClick" | "aria-checked" | "aria-pressed" | "children"
>;

interface ToggleProps extends NativeButtonProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The switch's accessible name; required because a switch has no text of its own. */
  label: string;
  busy?: boolean;
  /** `lm-toggle` is the pill switch; a row that draws its own track passes its class and children. */
  className?: string;
  children?: ReactNode;
}

/** An on/off setting that applies at once, announced as a switch. */
export function Toggle({
  checked,
  onChange,
  label,
  busy = false,
  className = "lm-toggle",
  children,
  ...rest
}: ToggleProps) {
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      className={className}
      onClick={() => onChange(!checked)}
    >
      {children}
    </button>
  );
}
