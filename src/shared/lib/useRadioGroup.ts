import { useRef, type KeyboardEvent } from "react";

export interface UseRadioGroupOptions<T extends string> {
  values: readonly T[];
  /** `null` when nothing is checked, e.g. the popup's modes while a test owns the light. */
  value: T | null;
  onChange: (value: T) => void;
  isDisabled?: (value: T) => boolean;
}

export interface RadioItemProps {
  role: "radio";
  "aria-checked": boolean;
  tabIndex: 0 | -1;
  ref: (element: HTMLElement | null) => void;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

const STEP_BY_KEY: Record<string, 1 | -1> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * The WAI-ARIA radio group: one tab stop, arrow keys move and check, Home and
 * End jump, disabled options are skipped. Headless — the caller keeps its own
 * markup and spreads `itemProps(value)` onto each option's button.
 */
export function useRadioGroup<T extends string>({
  values,
  value,
  onChange,
  isDisabled,
}: UseRadioGroupOptions<T>) {
  const elements = useRef(new Map<T, HTMLElement>());
  const enabled = values.filter((candidate) => !isDisabled?.(candidate));
  // With nothing checked, or the checked option disabled, the first enabled
  // option holds the tab stop — otherwise Tab would skip the group entirely.
  const tabStop = value !== null && enabled.includes(value) ? value : (enabled[0] ?? null);

  const focusAndSelect = (next: T | undefined) => {
    if (next === undefined) return;
    elements.current.get(next)?.focus();
    onChange(next);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>, from: T) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (enabled.length === 0) return;
    const step = STEP_BY_KEY[event.key];
    if (step !== undefined) {
      event.preventDefault();
      const index = enabled.indexOf(from);
      const start = index === -1 ? (step === 1 ? -1 : 0) : index;
      const next = enabled[(start + step + enabled.length) % enabled.length];
      if (next !== from) focusAndSelect(next);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? enabled[0] : enabled[enabled.length - 1];
      if (next !== from) focusAndSelect(next);
    }
  };

  const itemProps = (option: T): RadioItemProps => ({
    role: "radio",
    "aria-checked": option === value,
    tabIndex: option === tabStop ? 0 : -1,
    ref: (element) => {
      if (element) elements.current.set(option, element);
      else elements.current.delete(option);
    },
    onClick: () => onChange(option),
    onKeyDown: (event) => handleKeyDown(event, option),
  });

  return { itemProps };
}
