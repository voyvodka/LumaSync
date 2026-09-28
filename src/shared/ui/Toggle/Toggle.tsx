import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

import styles from "./Toggle.module.css";

/** The pill's class, for a placeholder that holds its place before the value is known. */
export const togglePillClass = styles.pill;

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
  /** The pill switch by default; a row that draws its own track passes its class and children. */
  className?: string;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/** An on/off setting that applies at once, announced as a switch. */
export function Toggle({
  checked,
  onChange,
  label,
  busy = false,
  className = styles.pill,
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
