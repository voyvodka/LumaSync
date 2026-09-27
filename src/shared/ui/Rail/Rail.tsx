import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cx } from "../cx";
import { useLeavingItems, type ListRow } from "../Reveal/useLeavingItems";
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
  // A row that arrives (a port plugged in) slides in; one that leaves closes where it stood.
  const rows = useLeavingItems(items, (item) => item.id);
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
        {runsOf(rows).map((run) =>
          run.group === undefined ? (
            run.rows.map((row) => <RailButton key={row.key} row={row} active={active} onSelect={onSelect} />)
          ) : (
            <RailGroup key={`${run.group}-${run.rows[0]?.key}`} heading={run.group}>
              {run.rows.map((row) => (
                <RailButton key={row.key} row={row} active={active} onSelect={onSelect} />
              ))}
            </RailGroup>
          ),
        )}
      </div>
    </nav>
  );
}

/** Consecutive rows that share a group, in order. */
function runsOf<Id extends string>(rows: readonly ListRow<RailItem<Id>>[]) {
  const runs: { group: string | undefined; rows: ListRow<RailItem<Id>>[] }[] = [];
  for (const row of rows) {
    const last = runs[runs.length - 1];
    if (last && last.group === row.item.group) last.rows.push(row);
    else runs.push({ group: row.item.group, rows: [row] });
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
  row,
  active,
  onSelect,
}: {
  row: ListRow<RailItem<Id>>;
  active: Id;
  onSelect: (id: Id) => void;
}) {
  const { item, leaving, arrived } = row;
  return (
    <button
      type="button"
      className={cx(styles.item, item.ghost && styles.ghost, arrived && styles.arrive, leaving && styles.leaving)}
      aria-current={item.id === active && !leaving ? "page" : undefined}
      aria-hidden={leaving || undefined}
      tabIndex={leaving ? -1 : undefined}
      disabled={leaving}
      onClick={() => onSelect(item.id)}
      data-testid={item.testId}
    >
      {item.dot && <span className={cx(styles.dot, item.dot.tone === "on" && styles.dotOn)} aria-hidden="true" />}
      <span className={styles.label}>{item.label}</span>
      {item.dot && <span className="sr-only">, {item.dot.label}</span>}
    </button>
  );
}
