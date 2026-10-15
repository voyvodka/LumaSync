import type { CSSProperties, KeyboardEvent, ReactNode, Ref } from "react";

import { cx } from "@/shared/lib/cx";
import { PageSwap } from "@/shared/ui/PageSwap/PageSwap";

import { DOCK_BOTTOM_PX, DOCK_HEIGHT_PX } from "./dockGeometry";
import styles from "./DockFrame.module.css";

const GEOMETRY = { "--room-dock-h": `${DOCK_HEIGHT_PX}px`, "--room-dock-bottom": `${DOCK_BOTTOM_PX}px` } as CSSProperties;

/** The floating box both faces' docks are drawn in: an optional rail, then one page at a time,
 *  faded in by `page`. */
export function DockFrame({
  dockRef,
  contentRef,
  label,
  page,
  rail,
  extra,
  onKeyDown,
  testId,
  glass = false,
  children,
}: {
  dockRef?: Ref<HTMLElement>;
  contentRef?: Ref<HTMLDivElement>;
  label: string;
  /** What the page is; a new one fades in. */
  page: string;
  rail?: ReactNode;
  /** Rendered beside the pages, not inside them: announcers and popovers that outlive a swap. */
  extra?: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  testId?: string;
  glass?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      ref={dockRef}
      className={cx(styles.dock, !rail && styles.single, glass && styles.glass)}
      style={GEOMETRY}
      aria-label={label}
      data-room-dock=""
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      {rail}
      {rail && <span className={styles.separator} aria-hidden="true" />}
      <div ref={contentRef} className={styles.content}>
        <PageSwap id={page} way="fade" className={styles.swap}>
          {children}
        </PageSwap>
      </div>
      {extra}
    </section>
  );
}
