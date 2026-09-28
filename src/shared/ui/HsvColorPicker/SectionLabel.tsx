import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";

type SectionLabelTone = "dim";

const TONE_CLASSNAME: Record<SectionLabelTone, string> = {
  dim: "text-[10px] uppercase tracking-wide text-ink-dim",
};

type SectionLabelOwnProps<T extends ElementType> = {
  as?: T;
  tone: SectionLabelTone;
  className?: string;
  children?: ReactNode;
};

type SectionLabelProps<T extends ElementType> = SectionLabelOwnProps<T> &
  Omit<ComponentPropsWithoutRef<T>, keyof SectionLabelOwnProps<T>>;

/** The picker's uppercase micro-labels. */
export function SectionLabel<T extends ElementType = "span">({
  as,
  tone,
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
