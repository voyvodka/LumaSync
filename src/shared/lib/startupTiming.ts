/**
 * A launch step with the wall-clock time it was reached, so the log lines up with Rust's
 * `[startup] … (run() at epoch …)` marks (`startup_timing.rs`): subtract that epoch to read each
 * step as milliseconds since launch.
 */
export function markStartup(step: string): void {
  console.info(`[LumaSync] [startup] ${step} at epoch ${Date.now()}`);
}
