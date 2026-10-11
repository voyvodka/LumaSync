import { useEffect, useState } from "react";

import type { PreviewSession } from "@/shared/contracts/preview";

import { getPreviewSession } from "../previewApi";
import { listenPreviewSession } from "../previewEventsApi";

/**
 * The session as Rust holds it, for the popup. The listener goes up before the read, so a change
 * between the two is not missed; an event that lands first is not overwritten by the older read.
 * `null` until the first answer, and after a read that failed.
 */
export function usePreviewSession(): PreviewSession | null {
  const [session, setSession] = useState<PreviewSession | null>(null);

  useEffect(() => {
    let alive = true;
    let heard = false;
    let unlisten: (() => void) | null = null;
    const read = () =>
      getPreviewSession().then((answer) => {
        if (alive && !heard && answer !== null) setSession(answer);
      });
    void listenPreviewSession((next) => {
      heard = true;
      if (alive) setSession(next);
    })
      .then((fn) => {
        if (!alive) {
          fn();
          return;
        }
        unlisten = fn;
        return read();
      })
      .catch((error: unknown) => {
        // Without the listener the popup still opens on the session as it is.
        console.error("[LumaSync] preview session listener failed:", error);
        return read();
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return session;
}
