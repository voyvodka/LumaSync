import { useEffect, useState } from "react";

import { prefersReducedMotion } from "./motion";

/**
 * Keeps something mounted while it leaves, so what arrives with motion also goes with it.
 * `mounted` is whether to render it, `leaving` whether to give it its exit. `exitMs` is a ceiling
 * past the exit's own length; with motion reduced it goes at once.
 */
export function usePresence(show: boolean, exitMs: number): { mounted: boolean; leaving: boolean } {
  const [lingering, setLingering] = useState(false);
  const [wasShown, setWasShown] = useState(show);
  if (wasShown !== show) {
    setWasShown(show);
    setLingering(!show && !prefersReducedMotion());
  }

  useEffect(() => {
    if (!lingering) return undefined;
    const timer = setTimeout(() => setLingering(false), exitMs);
    return () => clearTimeout(timer);
  }, [lingering, exitMs]);

  return { mounted: show || lingering, leaving: !show && lingering };
}
