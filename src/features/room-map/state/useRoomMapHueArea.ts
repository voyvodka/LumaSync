import { useEffect, useState } from "react";

import { shellStore } from "@/features/persistence/shellStore";
import { parseCommandError } from "@/shared/contracts/status";

export interface RoomMapHueArea {
  /** Cached active entertainment area id from shellStore — used when authoring Hue zones. */
  hueAreaId: string | null;
  hueBridgeConfigured: boolean;
  /** The paired bridge's address, which identify needs; the key comes from the keychain. */
  hueBridgeIp: string | null;
}

const UNKNOWN: RoomMapHueArea = { hueAreaId: null, hueBridgeConfigured: false, hueBridgeIp: null };

/** The area the room map's Hue channels and zones belong to, read once when the map opens. */
export function useRoomMapHueArea(): RoomMapHueArea {
  const [area, setArea] = useState<RoomMapHueArea>(UNKNOWN);

  // Load the persisted last-selected entertainment area id once. We do not
  // mount useHueOnboarding here to keep the editor decoupled from the
  // onboarding state machine; the area id alone is enough to author zones.
  useEffect(() => {
    let cancelled = false;
    void shellStore
      .load()
      .then((state) => {
        if (cancelled) return;
        // "Configured" is `hueAppKey` (legacy plaintext) OR a keychain backend. The
        // editor deliberately stops there — anything beyond needs `useHueOnboarding`,
        // and mounting that state machine here for a header is too much.
        const hasKeychain = state.credentialStorageBackend === "keychain";
        const hasLegacyKey = !!state.hueAppKey;
        const hasBridge = !!state.lastHueBridge;
        setArea({
          hueAreaId: state.lastHueAreaId ?? null,
          hueBridgeConfigured: hasBridge && (hasKeychain || hasLegacyKey),
          hueBridgeIp: state.lastHueBridge?.ip ?? null,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) console.warn(`[LumaSync] Room map Hue area not read: ${parseCommandError(error).message}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return area;
}
