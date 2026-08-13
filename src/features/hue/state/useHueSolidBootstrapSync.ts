import { useEffect, useRef, type RefObject } from "react";

import {
  LIGHTING_MODE_KIND,
  type LightingModeConfig,
  type SolidColorPayload,
} from "@/features/mode/model/contracts";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";

import { readHueStreamStatus } from "../hueReadCache";

export interface HueSolidBootstrapSyncInput {
  activeOutputTargets: HueRuntimeTarget[];
  lightingModeRef: RefObject<LightingModeConfig>;
  /** Invoked only when the bridge has a colour AND the UI is still in SOLID. */
  onAdoptSolid: (solid: SolidColorPayload) => void;
}

// ---------------------------------------------------------------------------
// Hue solid color bootstrap sync (Hue → UI yönünde okuma).
//
// Hue Running'e her girişte BİR KEZ backend'den lastSolidColor okunur:
//   - "hue" activeOutputTargets'a girince VE hueSolidSyncedRef false ise
//     → getHueStreamStatus() çağır → lastSolidColor varsa
//       → setLightingModeState({ kind: SOLID, solid: lastSolidColor }) yap.
//     → bayrağı true yap (loop'u önler).
//   - "hue" activeOutputTargets'tan çıkınca (stop/fail)
//     → bayrağı false sıfırla (sonraki bağlantı için hazırla).
//
// Kullanıcı renk değiştirince (isQuickSolidAdjustment yolu) bu bayrak
// DOKUNULMAZ — bu sayede UI'dan gelen değişiklik backend'den override edilmez.
// ---------------------------------------------------------------------------
export function useHueSolidBootstrapSync({
  activeOutputTargets,
  lightingModeRef,
  onAdoptSolid,
}: HueSolidBootstrapSyncInput): void {
  /**
   * hueSolidSyncedRef — "Bootstrap solid color sync" bayrağı.
   * Hue Running state'e her girişte bir kez lastSolidColor push edilir,
   * ardından true yapılır. Running dışına çıkınca false sıfırlanır.
   * Kullanıcı renk değiştirirken bu bayrak DOKUNULMAZ — loop'u önler.
   */
  const hueSolidSyncedRef = useRef(false);
  const prevHueActiveRef = useRef(false);
  // Held in a ref so the effect keeps `[activeOutputTargets]` as its only dep.
  const onAdoptSolidRef = useRef(onAdoptSolid);
  onAdoptSolidRef.current = onAdoptSolid;

  useEffect(() => {
    const hueNowActive = activeOutputTargets.includes("hue");

    if (!hueNowActive && prevHueActiveRef.current) {
      // Hue Running → başka state: bayrağı sıfırla
      hueSolidSyncedRef.current = false;
    }

    if (hueNowActive && !hueSolidSyncedRef.current) {
      // Hue Running'e yeni girdi ve henüz sync yapılmadı
      hueSolidSyncedRef.current = true;
      void readHueStreamStatus()
        .then((result) => {
          const snap = result.lastSolidColor;
          // Guard: only adopt the bridge's lastSolidColor when the UI is
          // (still) in SOLID mode. Without this check, a persisted Ambilight
          // session bootstrapping with hue_targets included would have the
          // UI silently flipped to Solid the moment the stream came up —
          // surfacing as bug #43 (LEDs animate, UI shows Solid) and
          // racing the active ambilight worker (bug #44).
          if (snap && lightingModeRef.current.kind === LIGHTING_MODE_KIND.SOLID) {
            onAdoptSolidRef.current({
              r: snap.r,
              g: snap.g,
              b: snap.b,
              brightness: snap.brightness,
            });
          }
        })
        .catch((error) => {
          console.error("[LumaSync] Bootstrap solid color read failed:", error);
          // Başarısız olursa sonraki bağlantıda tekrar denensin
          hueSolidSyncedRef.current = false;
        });
    }

    prevHueActiveRef.current = hueNowActive;
  }, [activeOutputTargets, lightingModeRef]);
}
