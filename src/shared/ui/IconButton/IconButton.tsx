import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cx } from "@/shared/lib/cx";
import styles from "./IconButton.module.css";

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
      className={cx(styles.icon, className)}
      {...rest}
    >
      {icon}
    </button>
  );
});
