/**
 * TwinErrorBoundary — minimal, transparent-fallback boundary for the
 * click-through digital-twin overlay (FE-5 fix).
 *
 * The twin lives in a borderless, transparent, full-display, click-through
 * webview. The shared `GlobalErrorBoundary` is the right boundary for the
 * popup / main window, but its fallback renders an OPAQUE amber card — in the
 * twin window that would blanket the entire display with a solid block the
 * user cannot dismiss (the overlay is click-through and has no chrome).
 *
 * So a render throw in the twin must degrade to an INVISIBLE overlay rather
 * than a white/opaque screen: this boundary renders nothing on error, leaving
 * only the already-transparent window behind (see `main.tsx`, which neutralizes
 * the html/body/#root background synchronously before React mounts). The
 * failure is still logged via `console.error`, which the `main.tsx`
 * console→tauri-plugin-log bridge mirrors to the on-disk log file — so this is
 * a silent-FALLBACK, never a silent-CATCH.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface TwinErrorBoundaryProps {
  children: ReactNode;
}

interface TwinErrorBoundaryState {
  hasError: boolean;
}

/** Error boundary for the twin overlay that degrades to an invisible window instead of an opaque fallback card. */
export class TwinErrorBoundary extends Component<
  TwinErrorBoundaryProps,
  TwinErrorBoundaryState
> {
  state: TwinErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): TwinErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(
      "[LumaSync] LedTwinOverlay render error — degrading to an invisible overlay:",
      error,
      errorInfo,
    );
  }

  render() {
    // Transparent fallback: render nothing so a twin failure leaves the
    // window fully see-through instead of an opaque full-screen block.
    if (this.state.hasError) return null;
    return this.props.children;
  }
}
