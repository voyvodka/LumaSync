import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";

type SectionLabelTone = "heading" | "zinc" | "dim";

/**
 * Exact legacy classNames from each call site, kept verbatim per tone so
 * centralizing the markup does not change any rendered output.
 */
const TONE_CLASSNAME: Record<SectionLabelTone, string> = {
  heading:
    "flex items-center gap-1.5 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--lm-ink-faint)]",
  zinc: "text-[10px] font-semibold uppercase tracking-wide text-zinc-500",
  dim: "text-[10px] uppercase tracking-wide text-[color:var(--lm-ink-dim)]",
};

type SectionLabelOwnProps<T extends ElementType> = {
  as?: T;
  tone?: SectionLabelTone;
  className?: string;
  children?: ReactNode;
};

type SectionLabelProps<T extends ElementType> = SectionLabelOwnProps<T> &
  Omit<ComponentPropsWithoutRef<T>, keyof SectionLabelOwnProps<T>>;

/** Repeated uppercase micro-label markup used across settings/room-map panels. */
export function SectionLabel<T extends ElementType = "span">({
  as,
  tone = "zinc",
  className,
  children,
  ...rest
}: SectionLabelProps<T>) {
  const Tag = (as ?? "span") as ElementType;
  const base = TONE_CLASSNAME[tone];
  return (
    <Tag className={className ? `${base} ${className}` : base} {...rest}>
      {children}
    </Tag>
  );
}
