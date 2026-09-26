import { cx } from "@/shared/ui/cx";
import { IconCheck, IconUndo } from "@/shared/ui/icons";
import { StateSwap } from "@/shared/ui/StateSwap/StateSwap";
import styles from "./CommitCapsule.module.css";

interface CommitCapsuleProps {
  /** Unsaved edits exist: revert slides in beside the commit button. */
  dirty: boolean;
  /** There is something to commit (edits, or a layout never saved). */
  ready: boolean;
  committing: boolean;
  /** Just committed: the rest label reads "Saved" for a moment. */
  flash: boolean;
  labels: { commit: string; committing: string; rest: string; done: string; revert: string; unsaved: string };
  onCommit: () => void;
  onRevert: () => void;
}

/**
 * Save as one fixed-width capsule that is never empty: a quiet "✓ Saved" at rest, the amber
 * commit button once there is something to save, revert sliding in beside it for edits.
 */
export function CommitCapsule({ dirty, ready, committing, flash, labels, onCommit, onRevert }: CommitCapsuleProps) {
  const live = ready || committing;
  return (
    <div className={cx(styles.capsule, dirty && styles.dirty, live && styles.ready)}>
      <button
        type="button"
        onClick={onRevert}
        disabled={!dirty || committing}
        inert={!dirty || undefined}
        aria-hidden={!dirty || undefined}
        aria-label={labels.revert}
        title={labels.revert}
        className={styles.revert}
      >
        <IconUndo />
      </button>
      <span className={styles.slot}>
        <StateSwap
          state={live ? "commit" : "rest"}
          faces={{
            commit: (
              <button
                type="button"
                disabled={committing}
                aria-busy={committing || undefined}
                onClick={onCommit}
                title={dirty ? labels.unsaved : undefined}
                className={styles.commit}
              >
                {committing ? labels.committing : labels.commit}
              </button>
            ),
            rest: (
              <span role="status" className={cx(styles.rest, flash && styles.flash)}>
                <IconCheck />
                {flash ? labels.done : labels.rest}
              </span>
            ),
          }}
        />
      </span>
    </div>
  );
}
