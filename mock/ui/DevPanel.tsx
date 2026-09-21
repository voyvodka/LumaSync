/**
 * The dev panel: a scenario picker *and* a world editor.
 *
 * Presets are starting points, not the product. The useful work is composing a
 * world by hand — add a second strip, take the bridge off the network, delete
 * a channel, force one command to fail — because the state you need to see is
 * usually one step off a preset rather than on it.
 *
 * It mounts into its own React root appended to `<body>`, not the app's tree:
 *
 * - **`src/` must never name `mock/`.** That absence is what makes the
 *   ship-safety guarantee structural rather than a tree-shaking assumption,
 *   and `scripts/verify/mock-not-shipped.mjs` fails the build if it breaks.
 * - **The moment you most need to switch scenario is the moment a scenario
 *   crashed the render.** A panel inside the app's error boundary is gone
 *   exactly then.
 *
 * Edits apply live — the next poll or navigation picks them up. Nothing
 * remounts unless you ask, because a remount throws away whatever you had
 * arranged on screen. `Reload app` is there for the reads that only happen at
 * boot.
 *
 * It is deliberately ugly — hazard stripes, monospace, no product tokens — so
 * it can never be mistaken for the app in a screenshot.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { MOCK_HAS_REAL_IPC } from "../runtime";
import { SCENARIOS, SCENARIO_IDS, type ScenarioId } from "../scenarios";
import { clearStoredWorld, getWorld, mutate, setWorld, subscribe } from "../state";

const STRIPES = "repeating-linear-gradient(45deg, #1c1917 0 8px, #451a03 8px 16px)";
const FONT = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
const AMBER = "#fbbf24";
const DIM = "#78716c";
const LINE = "#292524";

/** `Ctrl+Shift+M`, matched on `code` so a TR layout behaves the same. It is
 *  deliberately not in `KEYBIND_REGISTRY` — that contract is rendered as
 *  badges in the status bar, and a dev action there is a false promise. */
const SUMMON_CODE = "KeyM";

/** Commands worth offering as one-click failures: each has a distinct UI path. */
const FAILABLE = [
  "list_serial_ports",
  "connect_serial_port",
  "run_serial_health_check",
  "discover_wled_devices",
  "connect_wled_sink",
  "discover_hue_bridges",
  "pair_hue_bridge",
  "list_hue_entertainment_areas",
  "get_hue_area_channels",
  "start_hue_stream",
  "set_lighting_mode",
];

const btn: React.CSSProperties = {
  background: "transparent",
  border: `1px solid ${LINE}`,
  color: "#e7e5e4",
  cursor: "pointer",
  font: `10px ${FONT}`,
  padding: "3px 6px",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: `1px solid ${LINE}`, paddingTop: 6, marginTop: 6 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ ...btn, border: "none", width: "100%", textAlign: "left", color: AMBER, padding: 0 }}
      >
        {open ? "▾" : "▸"} {title}
      </button>
      {open && <div style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>{children}</div>
  );
}

function Toggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      style={{
        ...btn,
        width: "100%",
        textAlign: "left",
        borderColor: on ? "#b45309" : LINE,
        color: on ? AMBER : DIM,
      }}
    >
      [{on ? "×" : " "}] {label}
    </button>
  );
}

interface PanelProps {
  onReloadApp: (scenario: ScenarioId) => void;
}

export function DevPanel({ onReloadApp }: PanelProps) {
  const [open, setOpen] = useState(false);
  const world = useSyncExternalStore(subscribe, getWorld);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.code === SUMMON_CODE && event.ctrlKey && event.shiftKey) {
        event.preventDefault();
        setOpen((v) => !v);
      }
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const applyScenario = useCallback(
    (id: ScenarioId, reload: boolean) => {
      clearStoredWorld();
      setWorld(SCENARIOS[id].build());
      if (reload) onReloadApp(id);
    },
    [onReloadApp],
  );

  const nextPortIndex = world.serial.ports.length + 1;
  const nextChannelIndex =
    world.hue.channels.reduce((max, c) => Math.max(max, c.index), -1) + 1;

  return (
    <>
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
          color: AMBER,
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
        MOCK · {world.scenario}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Dev mock world"
          style={{
            position: "fixed",
            left: 22,
            top: 8,
            bottom: 8,
            width: 292,
            overflowY: "auto",
            background: "#0c0a09",
            border: "1px solid #78350f",
            color: "#e7e5e4",
            font: `11px ${FONT}`,
            padding: 10,
            zIndex: 2147483000,
            boxShadow: "0 10px 40px rgba(0,0,0,.7)",
          }}
        >
          <div style={{ background: STRIPES, height: 4, margin: "-10px -10px 8px" }} />
          <div style={{ color: AMBER, letterSpacing: "0.1em" }}>DEV MOCK</div>
          <div style={{ color: DIM, margin: "2px 0 8px", lineHeight: 1.4 }}>
            {MOCK_HAS_REAL_IPC
              ? "tauri — fixtures answer, passthrough reaches Rust"
              : "browser — fixtures answer, no backend behind passthrough"}
          </div>

          <Row>
            <button type="button" style={{ ...btn, flex: 1 }} onClick={() => onReloadApp(world.scenario)}>
              Reload app
            </button>
            <button
              type="button"
              style={{ ...btn, flex: 1 }}
              onClick={() => applyScenario(world.scenario, true)}
            >
              Reset world
            </button>
          </Row>

          <Section title={`PRESETS · ${SCENARIOS[world.scenario].label}`}>
            {SCENARIO_IDS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={(e) => applyScenario(id, !e.shiftKey)}
                style={{
                  ...btn,
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  marginBottom: 3,
                  padding: "5px 7px",
                  background: id === world.scenario ? "#292524" : "transparent",
                  borderColor: id === world.scenario ? "#b45309" : LINE,
                }}
              >
                <div style={{ color: id === world.scenario ? AMBER : "#e7e5e4", fontSize: 11 }}>
                  {SCENARIOS[id].label}
                </div>
                <div style={{ color: DIM, fontSize: 10, lineHeight: 1.35, marginTop: 2 }}>
                  {SCENARIOS[id].summary}
                </div>
              </button>
            ))}
            <div style={{ color: "#57534e", fontSize: 10, lineHeight: 1.35, marginTop: 4 }}>
              A preset replaces the world and reloads. Shift-click swaps it under
              the running app instead — that is the mode where a response landing
              after its scenario is gone reports itself.
            </div>
          </Section>

          <Section title={`USB STRIPS · ${world.serial.ports.length}`}>
            {world.serial.ports.map((port) => {
              const connected = world.serial.connectedPort === port.name;
              return (
                <div key={port.name} style={{ border: `1px solid ${LINE}`, padding: 5, marginBottom: 4 }}>
                  <div style={{ color: connected ? AMBER : "#e7e5e4", fontSize: 10 }}>{port.name}</div>
                  <div style={{ color: DIM, fontSize: 10, marginBottom: 4 }}>
                    {port.product ?? "unknown"} · {port.supported ? "allowlisted" : "not allowlisted"}
                  </div>
                  <Row>
                    <button
                      type="button"
                      style={{ ...btn, flex: 1, color: connected ? AMBER : "#e7e5e4" }}
                      onClick={() =>
                        mutate((w) => {
                          w.serial.connectedPort = connected ? null : port.name;
                        })
                      }
                    >
                      {connected ? "Disconnect" : "Connect"}
                    </button>
                    <button
                      type="button"
                      style={{ ...btn, flex: 1 }}
                      onClick={() =>
                        mutate((w) => {
                          w.serial.ports = w.serial.ports.filter((p) => p.name !== port.name);
                          if (w.serial.connectedPort === port.name) w.serial.connectedPort = null;
                        })
                      }
                    >
                      Remove
                    </button>
                  </Row>
                  <button
                    type="button"
                    style={{ ...btn, width: "100%" }}
                    onClick={() =>
                      mutate((w) => {
                        const p = w.serial.ports.find((x) => x.name === port.name);
                        if (p !== undefined) p.supported = !p.supported;
                      })
                    }
                  >
                    Toggle allowlist verdict
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              style={{ ...btn, width: "100%" }}
              onClick={() =>
                mutate((w) => {
                  w.serial.ports.push({
                    name: `/dev/cu.usbserial-${1400 + nextPortIndex}`,
                    supported: true,
                    vid: 0x1a86,
                    pid: 0x7523,
                    manufacturer: "wch.cn",
                    product: "CH340 USB Serial",
                    connectOutcome: "OK",
                    firmwareProfile: "lumasync-v1",
                    chipType: "ws2812b-grb",
                  });
                })
              }
            >
              + Add strip
            </button>
          </Section>

          <Section title={`HUE · ${world.hue.bridges.length} bridge(s)`}>
            {world.hue.bridges.map((bridge) => {
              const selected = world.hue.selectedBridgeId === bridge.id;
              return (
                <div key={bridge.id} style={{ border: `1px solid ${LINE}`, padding: 5, marginBottom: 4 }}>
                  <div style={{ color: selected ? AMBER : "#e7e5e4", fontSize: 10 }}>{bridge.name}</div>
                  <div style={{ color: DIM, fontSize: 10, marginBottom: 4 }}>{bridge.ip}</div>
                  <Row>
                    <button
                      type="button"
                      style={{ ...btn, flex: 1 }}
                      onClick={() =>
                        mutate((w) => {
                          w.hue.selectedBridgeId = selected ? null : bridge.id;
                        })
                      }
                    >
                      {selected ? "Deselect" : "Select"}
                    </button>
                    <button
                      type="button"
                      style={{ ...btn, flex: 1 }}
                      onClick={() =>
                        mutate((w) => {
                          w.hue.bridges = w.hue.bridges.filter((b) => b.id !== bridge.id);
                          if (w.hue.selectedBridgeId === bridge.id) w.hue.selectedBridgeId = null;
                        })
                      }
                    >
                      Remove
                    </button>
                  </Row>
                </div>
              );
            })}
            <button
              type="button"
              style={{ ...btn, width: "100%", marginBottom: 6 }}
              onClick={() =>
                mutate((w) => {
                  const n = w.hue.bridges.length + 1;
                  w.hue.bridges.push({
                    id: `bridge-mock-${n}`,
                    ip: `192.168.1.${180 + n}`,
                    name: `Hue Bridge ${n}`,
                  });
                })
              }
            >
              + Add bridge
            </button>

            <Toggle
              on={world.hue.reachable}
              label="Bridge reachable"
              onClick={() =>
                mutate((w) => {
                  w.hue.reachable = !w.hue.reachable;
                })
              }
            />
            <Toggle
              on={world.hue.credentialValid}
              label="Application key accepted"
              onClick={() =>
                mutate((w) => {
                  w.hue.credentialValid = !w.hue.credentialValid;
                })
              }
            />
            <Toggle
              on={world.hue.appKey !== null}
              label="Paired (key present)"
              onClick={() =>
                mutate((w) => {
                  w.hue.appKey = w.hue.appKey === null ? "mock-application-key" : null;
                })
              }
            />
            <Toggle
              on={world.hue.streaming}
              label="Entertainment streaming"
              onClick={() =>
                mutate((w) => {
                  w.hue.streaming = !w.hue.streaming;
                })
              }
            />
            <Row>
              <span style={{ color: DIM, fontSize: 10 }}>Link-button polls left</span>
              <input
                type="number"
                min={0}
                max={9}
                value={world.hue.linkButtonPressesRemaining}
                onChange={(e) =>
                  mutate((w) => {
                    w.hue.linkButtonPressesRemaining = Math.max(0, Number(e.target.value));
                  })
                }
                style={{ ...btn, width: 44, cursor: "text" }}
              />
            </Row>
          </Section>

          <Section title={`HUE AREAS · ${world.hue.areas.length}`}>
            {world.hue.areas.map((area) => {
              const selected = world.hue.selectedAreaId === area.id;
              return (
                <Row key={area.id}>
                  <button
                    type="button"
                    style={{ ...btn, flex: 1, textAlign: "left", color: selected ? AMBER : "#e7e5e4" }}
                    onClick={() =>
                      mutate((w) => {
                        w.hue.selectedAreaId = area.id;
                      })
                    }
                  >
                    {area.name} · {area.channelCount}
                  </button>
                  <button
                    type="button"
                    style={btn}
                    onClick={() =>
                      mutate((w) => {
                        w.hue.areas = w.hue.areas.filter((a) => a.id !== area.id);
                        if (w.hue.selectedAreaId === area.id) w.hue.selectedAreaId = null;
                      })
                    }
                  >
                    ×
                  </button>
                </Row>
              );
            })}
            <button
              type="button"
              style={{ ...btn, width: "100%" }}
              onClick={() =>
                mutate((w) => {
                  const n = w.hue.areas.length + 1;
                  w.hue.areas.push({
                    id: `area-mock-${n}`,
                    name: `Area ${n}`,
                    channelCount: 0,
                    roomName: null,
                    activeStreamer: false,
                  });
                })
              }
            >
              + Add area
            </button>
          </Section>

          <Section title={`HUE CHANNELS · ${world.hue.channels.length}`}>
            {world.hue.channels.map((channel) => (
              <Row key={channel.index}>
                <span style={{ color: DIM, width: 18, fontSize: 10 }}>#{channel.index}</span>
                <input
                  value={channel.name}
                  onChange={(e) =>
                    mutate((w) => {
                      const c = w.hue.channels.find((x) => x.index === channel.index);
                      if (c !== undefined) c.name = e.target.value;
                    })
                  }
                  style={{ ...btn, flex: 1, cursor: "text" }}
                />
                <button
                  type="button"
                  style={btn}
                  onClick={() =>
                    mutate((w) => {
                      w.hue.channels = w.hue.channels.filter((c) => c.index !== channel.index);
                    })
                  }
                >
                  ×
                </button>
              </Row>
            ))}
            <button
              type="button"
              style={{ ...btn, width: "100%" }}
              onClick={() =>
                mutate((w) => {
                  // Numbered past the highest in use, not by count — the room map
                  // once handed a new light a number another light already had.
                  w.hue.channels.push({ index: nextChannelIndex, name: `Light ${nextChannelIndex}` });
                })
              }
            >
              + Add channel
            </button>
          </Section>

          <Section title={`WLED · ${world.wled.devices.length}`}>
            {world.wled.devices.map((device) => {
              const connected = world.wled.connectedHost === device.host;
              return (
                <Row key={device.host}>
                  <button
                    type="button"
                    style={{ ...btn, flex: 1, textAlign: "left", color: connected ? AMBER : "#e7e5e4" }}
                    onClick={() =>
                      mutate((w) => {
                        w.wled.connectedHost = connected ? null : device.host;
                      })
                    }
                  >
                    {device.name} · {device.ledCount}
                  </button>
                  <button
                    type="button"
                    style={btn}
                    onClick={() =>
                      mutate((w) => {
                        w.wled.devices = w.wled.devices.filter((d) => d.host !== device.host);
                        if (w.wled.connectedHost === device.host) w.wled.connectedHost = null;
                      })
                    }
                  >
                    ×
                  </button>
                </Row>
              );
            })}
            <button
              type="button"
              style={{ ...btn, width: "100%" }}
              onClick={() =>
                mutate((w) => {
                  const n = w.wled.devices.length + 1;
                  w.wled.devices.push({
                    host: `192.168.1.${41 + n}`,
                    name: `WLED Panel ${n}`,
                    ledCount: 120,
                    port: 4048,
                    protocol: "ddp",
                  });
                })
              }
            >
              + Add WLED device
            </button>
          </Section>

          <Section title={`DISPLAYS · ${world.displays.length}`}>
            {world.displays.map((display) => (
              <Row key={display.id}>
                <span style={{ flex: 1, fontSize: 10 }}>
                  {display.name} · {display.width}×{display.height}
                </span>
                <button
                  type="button"
                  style={btn}
                  onClick={() =>
                    mutate((w) => {
                      w.displays = w.displays.filter((d) => d.id !== display.id);
                    })
                  }
                >
                  ×
                </button>
              </Row>
            ))}
            <button
              type="button"
              style={{ ...btn, width: "100%" }}
              onClick={() =>
                mutate((w) => {
                  const n = w.displays.length + 1;
                  w.displays.push({
                    id: `display-mock-${n}`,
                    name: `Display ${n}`,
                    width: 1920,
                    height: 1080,
                  });
                })
              }
            >
              + Add display
            </button>
          </Section>

          <Section title="SYSTEM">
            <Toggle
              on={world.capture.permissionGranted}
              label="Screen recording permitted"
              onClick={() =>
                mutate((w) => {
                  w.capture.permissionGranted = !w.capture.permissionGranted;
                })
              }
            />
            <Toggle
              on={world.persistFails}
              label="Store writes fail"
              onClick={() =>
                mutate((w) => {
                  w.persistFails = !w.persistFails;
                })
              }
            />
          </Section>

          <Section title={`FORCED FAILURES · ${world.forcedFailures.length}`}>
            {FAILABLE.map((command) => (
              <Toggle
                key={command}
                on={world.forcedFailures.includes(command)}
                label={command}
                onClick={() =>
                  mutate((w) => {
                    w.forcedFailures = w.forcedFailures.includes(command)
                      ? w.forcedFailures.filter((c) => c !== command)
                      : [...w.forcedFailures, command];
                  })
                }
              />
            ))}
          </Section>

          <Section title={`TIMING · +${world.extraLatencyMs} ms`}>
            <input
              type="range"
              min={0}
              max={3000}
              step={100}
              value={world.extraLatencyMs}
              onChange={(e) =>
                mutate((w) => {
                  w.extraLatencyMs = Number(e.target.value);
                })
              }
              style={{ width: "100%" }}
            />
            <div style={{ color: "#57534e", fontSize: 10, lineHeight: 1.35 }}>
              Added on top of each fixture&apos;s own delay. Raise it to make
              loading states visible and to widen the window where a response can
              be overtaken — a mock that answers instantly hides both.
            </div>
          </Section>

          <Section title="REAL BACKEND EFFECTS">
            <button
              type="button"
              disabled={!MOCK_HAS_REAL_IPC}
              onClick={() => {
                void import("@tauri-apps/api/core").then(({ invoke }) => invoke("simulate_hue_fault"));
              }}
              style={{
                ...btn,
                width: "100%",
                borderColor: "#7f1d1d",
                color: MOCK_HAS_REAL_IPC ? "#fca5a5" : "#57534e",
                cursor: MOCK_HAS_REAL_IPC ? "pointer" : "not-allowed",
              }}
            >
              Simulate Hue DTLS fault
            </button>
            <div style={{ color: "#57534e", fontSize: 10, lineHeight: 1.35, marginTop: 4 }}>
              {MOCK_HAS_REAL_IPC
                ? "Not a fixture — this reaches Rust and fires the real reconnect monitor. Everything above fakes a state; this causes one."
                : "Unavailable in the browser: there is no backend to fault."}
            </div>
          </Section>
        </div>
      )}
    </>
  );
}
