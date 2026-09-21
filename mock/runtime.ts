/**
 * Which runtime the mock is living in. Split out of `boot.ts` so the panel can
 * read it without importing the bootstrap and creating a cycle.
 *
 * `webview.rs` defines `isTauri` in every real Tauri window; a browser tab has
 * nothing. The distinction decides whether passthrough can reach anything:
 * under `tauri dev` it reaches Rust, in the browser there is no backend behind
 * it, so a control with real effects has to present itself as unavailable
 * rather than quietly doing nothing.
 */
export const MOCK_HAS_REAL_IPC: boolean = "isTauri" in window && window.isTauri === true;
