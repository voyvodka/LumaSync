/** Stops a slower earlier run committing over a faster later one. Nothing is
 * cancelled; check `isLatest()` after every `await`, not once at the top. */
export interface LatestOperationGuard {
  /** Start a run; the returned predicate holds only while it is still newest. */
  begin: () => () => boolean;
}

export function createLatestOperationGuard(): LatestOperationGuard {
  let generation = 0;

  return {
    begin: () => {
      const mine = ++generation;
      return () => mine === generation;
    },
  };
}
