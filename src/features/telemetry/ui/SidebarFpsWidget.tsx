import { useEffect, useState } from "react";

import { getFullTelemetrySnapshot } from "../telemetryApi";
import type { FullTelemetrySnapshot } from "../model/contracts";

const POLL_INTERVAL_MS = 800;

function fmt(value: number): string {
  return value.toFixed(1);
}

function healthColor(health: string): string {
  if (health === "warning") return "text-amber-400";
  if (health === "critical") return "text-rose-400";
  return "text-emerald-400";
}

/** Compact FPS readout shown in the sidebar — only rendered in dev builds. */
export function SidebarFpsWidget() {
  const [snap, setSnap] = useState<FullTelemetrySnapshot | null>(null);

  useEffect(() => {
    let mounted = true;

    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const next = await getFullTelemetrySnapshot();
        if (mounted) setSnap(next);
      } catch {
        // silent — widget is debug-only
      }
    };

    void refresh();
    const id = window.setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
    return () => { mounted = false; window.clearInterval(id); };
  }, []);

  const active = snap && (snap.usb.captureFps > 0 || snap.usb.sendFps > 0);

  return (
    <div className="border-t border-slate-200/70 px-3 py-2.5 dark:border-zinc-800">
      <p className="mb-1 text-[9px] font-bold uppercase tracking-widest text-slate-400 dark:text-zinc-600">
        FPS
      </p>
      {active ? (
        <table className="w-full text-[10px] tabular-nums">
          <tbody>
            <tr>
              <td className="pr-1 text-slate-400 dark:text-zinc-500">cap</td>
              <td className="text-right font-semibold text-slate-700 dark:text-zinc-200">
                {fmt(snap.usb.captureFps)}
              </td>
            </tr>
            <tr>
              <td className="pr-1 text-slate-400 dark:text-zinc-500">snd</td>
              <td className="text-right font-semibold text-slate-700 dark:text-zinc-200">
                {fmt(snap.usb.sendFps)}
              </td>
            </tr>
            <tr>
              <td className="pr-1 text-slate-400 dark:text-zinc-500">q</td>
              <td className={`text-right font-semibold ${healthColor(snap.usb.queueHealth)}`}>
                {snap.usb.queueHealth.slice(0, 4)}
              </td>
            </tr>
            {snap.hue && snap.hue.packetRate > 0 && (
              <tr>
                <td className="pr-1 text-slate-400 dark:text-zinc-500">hue</td>
                <td className="text-right font-semibold text-violet-500 dark:text-violet-400">
                  {fmt(snap.hue.packetRate)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <p className="text-[10px] text-slate-300 dark:text-zinc-600">—</p>
      )}
    </div>
  );
}
