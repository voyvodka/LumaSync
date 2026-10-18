/**
 * At most one send in flight and one waiting, the waiting one always the
 * newest: a slider drag sends its first and last values and skips the ones in
 * between, however slowly the backend answers.
 */
export function createLatestSender<T>(send: (value: T) => Promise<unknown>): (value: T) => void {
  let inFlight = false;
  let pending: { value: T } | null = null;
  const start = (value: T) => {
    inFlight = true;
    void send(value)
      .catch((error: unknown) => {
        console.error("[LumaSync] a preview send failed:", error);
      })
      .finally(() => {
        inFlight = false;
        const next = pending;
        pending = null;
        if (next !== null) start(next.value);
      });
  };
  return (value) => {
    if (inFlight) {
      pending = { value };
      return;
    }
    start(value);
  };
}
