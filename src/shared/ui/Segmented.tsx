import type { CSSProperties, ReactNode } from "react";

import { cx } from "./cx";
import { useRadioGroup } from "./useRadioGroup";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
  /** For an option whose visible label does not name it on its own. */
  ariaLabel?: string;
  lang?: string;
  testId?: string;
  className?: string;
  style?: CSSProperties;
}

interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** Id of the line that explains the choice, read after the group's name. */
  ariaDescribedBy?: string;
  /** The group's look is the caller's: every strip in the app keeps its own class. */
  className?: string;
  itemClassName?: string;
  disabled?: boolean;
}

/** A single-choice strip rendered as a real radio group (see `useRadioGroup`). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  ariaDescribedBy,
  className,
  itemClassName,
  disabled = false,
}: SegmentedProps<T>) {
  const byValue = new Map(options.map((option) => [option.value, option]));
  const isDisabled = (candidate: T) => disabled || byValue.get(candidate)?.disabled === true;
  const { itemProps } = useRadioGroup({
    values: options.map((option) => option.value),
    value,
    onChange,
    isDisabled,
  });

  return (
    <div
      className={className}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-disabled={disabled || undefined}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          {...itemProps(option.value)}
          disabled={isDisabled(option.value)}
          className={cx(itemClassName, option.className) || undefined}
          style={option.style}
          title={option.title}
          aria-label={option.ariaLabel}
          lang={option.lang}
          data-testid={option.testId}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
