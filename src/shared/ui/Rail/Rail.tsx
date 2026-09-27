import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cx } from "../cx";
import styles from "./Rail.module.css";

export interface RailItem<Id extends string> {
  id: Id;
  label: string;
  /** A heading drawn above the first item of each run of the same group. */
  group?: string;
  /** A state dot before the label, with its meaning read in its place. */
  dot?: { tone: "on" | "off"; label: string };
  /** Something there to add rather than something already here: drawn faint. */
  ghost?: boolean;
  testId: string;
}

interface RailProps<Id extends string> {
  label: string;
  items: readonly RailItem<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
}

/**
 * A page's sub-pages, one row each. A `<nav>` with `aria-current`, not a tablist: a tablist would
 * promise arrow keys the rail does not implement. The selection is one tint that slides to the row;
 * it is placed by measuring, since group headings make the rows uneven.
 */
export function Rail<Id extends string>({ label, items, active, onSelect }: RailProps<Id>) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [tint, setTint] = useState<{ top: number; height: number } | null>(null);
  // The first placement lands without travel: the page opens with the tint already on its row.
  const [placed, setPlaced] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: items is the trigger — a row added above the active one moves it
  useLayoutEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row) {
      setTint(null);
      return;
    }
    const next = { top: row.offsetTop, height: row.offsetHeight };
    setTint((prev) => (prev && prev.top === next.top && prev.height === next.height ? prev : next));
  }, [active, items]);
  useLayoutEffect(() => {
    if (tint && !placed) setPlaced(true);
  }, [tint, placed]);

  return (
    <nav className={styles.rail} aria-label={label}>
      <div className={styles.list} ref={listRef}>
        {tint && (
          <span
            className={cx(styles.tint, placed && styles.moving)}
            style={{ transform: `translateY(${tint.top}px)`, height: tint.height }}
            aria-hidden="true"
          />
        )}
        {runsOf(items).map((run) =>
          run.group === undefined ? (
            run.items.map((item) => <RailButton key={item.id} item={item} active={active} onSelect={onSelect} />)
          ) : (
            <RailGroup key={`${run.group}-${run.items[0]?.id}`} heading={run.group}>
              {run.items.map((item) => (
                <RailButton key={item.id} item={item} active={active} onSelect={onSelect} />
              ))}
            </RailGroup>
          ),
        )}
      </div>
    </nav>
  );
}

/** Consecutive items that share a group, in order. */
function runsOf<Id extends string>(items: readonly RailItem<Id>[]) {
  const runs: { group: string | undefined; items: RailItem<Id>[] }[] = [];
  for (const item of items) {
    const last = runs[runs.length - 1];
    if (last && last.group === item.group) last.items.push(item);
    else runs.push({ group: item.group, items: [item] });
  }
  return runs;
}

/** A named group, so a screen reader hears "Strips" before the strips, as the eye sees it. */
function RailGroup({ heading, children }: { heading: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} className={styles.group}>
      <div id={headingId} className={styles.heading}>
        {heading}
      </div>
      {children}
    </div>
  );
}

function RailButton<Id extends string>({
  item,
  active,
  onSelect,
}: {
  item: RailItem<Id>;
  active: Id;
  onSelect: (id: Id) => void;
}) {
  return (
    <button
      type="button"
      className={cx(styles.item, item.ghost && styles.ghost)}
      aria-current={item.id === active ? "page" : undefined}
      onClick={() => onSelect(item.id)}
      data-testid={item.testId}
    >
      {item.dot && <span className={cx(styles.dot, item.dot.tone === "on" && styles.dotOn)} aria-hidden="true" />}
      <span className={styles.label}>{item.label}</span>
      {item.dot && <span className="sr-only">, {item.dot.label}</span>}
    </button>
  );
}
