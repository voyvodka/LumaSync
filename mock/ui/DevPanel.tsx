/**
 * The dev panel. Three layers: a collapsed edge tab, a scenario tray, and an
 * inspector for the per-value controls.
 *
 * It mounts into its own React root appended to `<body>`, not into the app's
 * tree. Two reasons, and both matter:
 *
 * - **`src/` must never name `mock/`.** That absence is what makes the
 *   ship-safety guarantee structural rather than a tree-shaking assumption,
 *   and `scripts/verify/mock-not-shipped.mjs` fails the build if it breaks.
 * - **The moment you most need to switch scenario is the moment a scenario
 *   crashed the render.** A panel inside the app's error boundary disappears
 *   exactly then.
 *
 * It is deliberately ugly — hazard stripes, monospace, no product tokens — so
 * it can never be mistaken for the app in a screenshot.
 */

import { useCallback, useEffect, useState } from "react";

import { SCENARIOS, SCENARIO_IDS, type ScenarioId } from "../scenarios";
import { getWorld, mutate, setWorld } from "../state";
import { MOCK_HAS_REAL_IPC } from "../runtime";

const STRIPES =
  "repeating-linear-gradient(45deg, #1c1917 0 8px, #451a03 8px 16px)";

const FONT = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';

/** `Ctrl+Shift+M`, matched on `code` so a TR layout behaves the same. It is
 *  deliberately not in `KEYBIND_REGISTRY` — that contract is rendered as
 *  badges in the status bar, and a dev action there is a false promise. */
const SUMMON = { code: "KeyM", ctrl: true, shift: true };

interface PanelProps {
  onScenarioChange: (id: ScenarioId) => void;
}

export function DevPanel({ onScenarioChange }: PanelProps) {
  const [open, setOpen] = useState(false);
  const [inspector, setInspector] = useState(false);
  const [scenario, setScenario] = useState<ScenarioId>(() => getWorld().scenario);
  const [latency, setLatency] = useState(0);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.code === SUMMON.code && event.ctrlKey === SUMMON.ctrl && event.shiftKey === SUMMON.shift) {
        event.preventDefault();
        setOpen((v) => !v);
      }
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const apply = useCallback(
    (id: ScenarioId, remount: boolean) => {
      setWorld(SCENARIOS[id].build());
      setScenario(id);
      setOpen(false);
      if (remount) onScenarioChange(id);
    },
    [onScenarioChange],
  );

  const tab = (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      title="Dev mock (Ctrl+Shift+M)"
      style={{
        position: "fixed",
        left: 0,
        top: "50%",
        transform: "translateY(-50%)",
        width: 22,
        padding: "14px 0",
        background: STRIPES,
        color: "#fbbf24",
        border: "1px solid #78350f",
        borderLeft: "none",
        borderRadius: "0 4px 4px 0",
        cursor: "pointer",
        font: `10px ${FONT}`,
        letterSpacing: "0.08em",
        writingMode: "vertical-rl",
        zIndex: 2147483000,
      }}
    >
      MOCK · {scenario}
    </button>
  );

  return (
    <>
      {tab}
      {open && (
        <div
          role="dialog"
          aria-label="Dev mock scenarios"
          style={{
            position: "fixed",
            left: 22,
            top: "50%",
            transform: "translateY(-50%)",
            width: 268,
            maxHeight: "86vh",
            overflowY: "auto",
            background: "#0c0a09",
            border: "1px solid #78350f",
            borderTop: `3px solid transparent`,
            borderImage: `${STRIPES} 3`,
            color: "#e7e5e4",
            font: `11px ${FONT}`,
            padding: 10,
            zIndex: 2147483000,
            boxShadow: "0 10px 40px rgba(0,0,0,.7)",
          }}
        >
          <div style={{ color: "#fbbf24", letterSpacing: "0.1em", marginBottom: 2 }}>DEV MOCK</div>
          <div style={{ color: "#a8a29e", marginBottom: 10, lineHeight: 1.4 }}>
            {MOCK_HAS_REAL_IPC
              ? "tauri — fixtures answer; passthrough reaches Rust"
              : "browser — fixtures answer; no backend behind passthrough"}
          </div>

          {SCENARIO_IDS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={(e) => apply(id, !e.shiftKey)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "6px 8px",
                marginBottom: 3,
                background: id === scenario ? "#292524" : "transparent",
                border: `1px solid ${id === scenario ? "#b45309" : "#292524"}`,
                color: "#e7e5e4",
                cursor: "pointer",
                font: `11px ${FONT}`,
              }}
            >
              <div style={{ color: id === scenario ? "#fbbf24" : "#e7e5e4" }}>
                {SCENARIOS[id].label}
              </div>
              <div style={{ color: "#78716c", fontSize: 10, lineHeight: 1.35, marginTop: 2 }}>
                {SCENARIOS[id].summary}
              </div>
            </button>
          ))}

          <div style={{ color: "#57534e", fontSize: 10, margin: "8px 0 10px" }}>
            Click applies and remounts. Shift-click swaps the fixtures without
            remounting — that is the mode that exposes stale responses.
          </div>

          <button
            type="button"
            onClick={() => setInspector((v) => !v)}
            style={{
              background: "none",
              border: "1px solid #292524",
              color: "#a8a29e",
              padding: "4px 8px",
              cursor: "pointer",
              font: `10px ${FONT}`,
              width: "100%",
            }}
          >
            {inspector ? "− INSPECTOR" : "+ INSPECTOR"}
          </button>

          {inspector && (
            <div style={{ marginTop: 10, borderTop: "1px solid #292524", paddingTop: 8 }}>
              <label style={{ display: "block", color: "#a8a29e", marginBottom: 4 }}>
                Extra latency: {latency} ms
              </label>
              <input
                type="range"
                min={0}
                max={3000}
                step={100}
                value={latency}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setLatency(next);
                  mutate((w) => {
                    w.extraLatencyMs = next;
                  });
                }}
                style={{ width: "100%" }}
              />
              <div style={{ color: "#57534e", fontSize: 10, lineHeight: 1.35, marginTop: 4 }}>
                Added on top of each fixture&apos;s own delay. Raise it to make
                loading states and ordering bugs visible; a mock that answers
                instantly hides both.
              </div>

              <div style={{ marginTop: 10, color: "#a8a29e" }}>Real backend effects</div>
              <button
                type="button"
                disabled={!MOCK_HAS_REAL_IPC}
                onClick={() => {
                  void import("@tauri-apps/api/core").then(({ invoke }) =>
                    invoke("simulate_hue_fault"),
                  );
                }}
                style={{
                  marginTop: 4,
                  width: "100%",
                  padding: "5px 8px",
                  background: "transparent",
                  border: "1px solid #7f1d1d",
                  color: MOCK_HAS_REAL_IPC ? "#fca5a5" : "#57534e",
                  cursor: MOCK_HAS_REAL_IPC ? "pointer" : "not-allowed",
                  font: `10px ${FONT}`,
                }}
              >
                Simulate Hue DTLS fault
              </button>
              <div style={{ color: "#57534e", fontSize: 10, lineHeight: 1.35, marginTop: 4 }}>
                {MOCK_HAS_REAL_IPC
                  ? "Not a fixture. This reaches Rust and fires the real reconnect monitor."
                  : "Unavailable in the browser — it needs a real backend to fault."}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
