/**
 * DEV ONLY — Hue fault simulation tool.
 * Calls the debug-only simulate_hue_fault Tauri command to trigger
 * a DTLS shutdown signal, exercising the reconnect pipeline.
 * Only available in debug builds.
 */
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type SimulationResult = {
  status: "idle" | "simulating" | "success" | "error";
  message: string;
};

export function HueFaultSimulator() {
  const [result, setResult] = useState<SimulationResult>({
    status: "idle",
    message: "",
  });

  const handleSimulate = async () => {
    setResult({ status: "simulating", message: "Firing shutdown signal..." });
    try {
      const response = await invoke<string>("simulate_hue_fault");
      setResult({ status: "success", message: response });
    } catch (err) {
      setResult({
        status: "error",
        message: typeof err === "string" ? err : String(err),
      });
    }
  };

  return (
    <div className="rounded-xl border border-slate-200/80 bg-white/90 p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
        Hue Fault Simulator
      </h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-zinc-300">
        Dev only. Fires the DTLS shutdown signal to trigger the reconnect
        pipeline. Requires an active DTLS stream.
      </p>

      <button
        type="button"
        onClick={() => { void handleSimulate(); }}
        disabled={result.status === "simulating"}
        className="mt-4 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-slate-900 hover:bg-slate-900 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
      >
        {result.status === "simulating" ? "Simulating..." : "Simulate DTLS Drop"}
      </button>

      {result.message ? (
        <pre className="mt-3 rounded-lg border border-slate-200/80 bg-slate-50/70 px-3 py-2 font-mono text-xs text-slate-700 dark:border-zinc-800 dark:bg-zinc-800/40 dark:text-zinc-300">
          {result.message}
        </pre>
      ) : null}
    </div>
  );
}
