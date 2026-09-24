import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cx } from "./cx";

export type ButtonVariant = "secondary" | "primary" | "danger";
export type ButtonSize = "sm" | "md";

const SIZE_CLASS = { sm: "lm-btn", md: "lm-btn-md" } satisfies Record<ButtonSize, string>;
const VARIANT_CLASS = {
  secondary: undefined,
  primary: "is-primary",
  danger: "is-danger",
} satisfies Record<ButtonVariant, string | undefined>;

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant;
  /** `sm` is the mono-caps chip of the device pages, `md` the 32 px row button. */
  size?: ButtonSize;
  /** Disables the button and marks it `aria-busy` while its action runs. */
  busy?: boolean;
  type?: "button" | "submit";
  children?: ReactNode;
}

/** A text action. Never a submit button unless asked: nothing in the app is a form. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "sm", busy = false, disabled, className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(SIZE_CLASS[size], VARIANT_CLASS[variant], className)}
      {...rest}
    />
  );
});

interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "aria-label" | "children"> {
  /** Names the button and becomes its tooltip: an icon alone says nothing to a screen reader. */
  label: string;
  icon: ReactNode;
  /** Off when a visible tooltip would repeat a label already on screen. */
  showTooltip?: boolean;
}

/** An icon-only action with a guaranteed name and a 32 px hit area. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, showTooltip = true, className, title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={showTooltip ? (title ?? label) : title}
      className={cx("lm-icon-btn", className)}
      {...rest}
    >
      {icon}
    </button>
  );
});
