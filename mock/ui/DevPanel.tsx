/**
 * The dev panel: a scenario picker, a world editor, and a search box.
 *
 * Presets are starting points, not the product. The useful work is composing a
 * world by hand, because the state you need to see is usually one step off a
 * preset rather than on it.
 *
 * **Search rather than better browsing.** At this many controls, grouping
 * alone does not help: a developer arrives with a question ("what does this
 * look like in Turkish", "what happens when the key expires"), not a category,
 * and browsing means reading past forty irrelevant rows to reach one. That was
 * the failure the ten presets already had. Search matches labels *and*
 * `ShellState` field names, because half the time the developer got here from
 * reading `shell.ts` and knows `hasCompletedOnboarding`, not "first run".
 *
 * Sections are grouped by **screen**, not by domain, since the mental index is
 * "the screen I am looking at". FAULTS is the deliberate exception: a failure
 * is a cross-cutting question, and keeping every injection in one place means
 * one glance tells you whether you left something forced on.
 *
 * It mounts into its own React root appended to `<body>`, not the app's tree:
 * `src/` must never name `mock/` — that absence is what makes the ship-safety
 * guarantee structural — and a render crash in the app must not take the panel
 * down at the moment a scenario switch is most wanted.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { OFFERED_CODES } from "../handlers/codes";
import {
  EDGE_SIGNAL_INTERVAL_MS,
  SHELL_EVENTS,
  emitLightingModeChanged,
  emitMockEvent,
  emitUpdateDownload,
  getEdgeSignalStream,
  startEdgeSignalStream,
  stopEdgeSignalStream,
  subscribeToEdgeSignalStream,
} from "../events";
import { rejectSerialPort, setSerialConnected, setWledBound } from "../hotplug";
import { ROOM_MAP_PRESETS, ROOM_MAP_PRESET_IDS, type RoomMapPresetId } from "../roomMaps";
import { PICKER_PATTERN_KINDS } from "../../src/features/preview/ui/PatternPicker";
import { MOCK_HAS_REAL_IPC } from "../runtime";
import { SCENARIOS, SCENARIO_IDS, type ScenarioId } from "../scenarios";
import { clearStoredWorld, getWorld, mutate, setWorld, subscribe } from "../state";
import type { MockWorld } from "../state";

const STRIPES = "repeating-linear-gradient(45deg, #1c1917 0 8px, #451a03 8px 16px)";
const FONT = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
const AMBER = "#fbbf24";
const DIM = "#78716c";
const FAINT = "#57534e";
const LINE = "#292524";

/** `Ctrl+Shift+M`, matched on `code` so a TR layout behaves the same. It is
 *  deliberately not in `KEYBIND_REGISTRY` — that contract is rendered as
 *  badges in the status bar, and a dev action there is a false promise. */
const SUMMON_CODE = "KeyM";

const OPEN_SECTIONS_KEY = "lumasync.mock.openSections";

const btn: React.CSSProperties = {
  background: "transparent",
  border: `1px solid ${LINE}`,
  color: "#e7e5e4",
  cursor: "pointer",
  font: `10px ${FONT}`,
  padding: "3px 6px",
};

/** Applies live, needs a section revisit, or needs a reload. Rendered on every
 *  control, because a control that silently does nothing is the worst outcome
 *  available here. */
type Reach = "live" | "remount" | "reload";

const REACH_LABEL: Record<Reach, string> = {
  live: "live",
  remount: "revisit",
  reload: "reload",
};

function ReachBadge({ reach }: { reach: Reach }) {
  return (
    <span style={{ color: FAINT, fontSize: 9, marginLeft: 4 }}>[{REACH_LABEL[reach]}]</span>
  );
}

interface CtlProps {
  /** Words the search box matches, beyond the label. Include field names. */
  keywords: string;
  label: string;
  reach: Reach;
  query: string;
  children: React.ReactNode;
}

function Ctl({ keywords, label, reach, query, children }: CtlProps) {
  const hay = `${label} ${keywords}`.toLowerCase();
  if (query.length > 0 && !hay.includes(query)) return null;
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ color: DIM, fontSize: 10, marginBottom: 2 }}>
        {label}
        <ReachBadge reach={reach} />
      </div>
      {children}
    </div>
  );
}

function Section({
  title,
  query,
  children,
}: {
  title: string;
  query: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    try {
      return (JSON.parse(sessionStorage.getItem(OPEN_SECTIONS_KEY) ?? "[]") as string[]).includes(
        title,
      );
    } catch {
      return false;
    }
  });

  const toggle = () => {
    setOpen((was) => {
      const next = !was;
      try {
        const list = new Set(
          JSON.parse(sessionStorage.getItem(OPEN_SECTIONS_KEY) ?? "[]") as string[],
        );
        if (next) list.add(title);
        else list.delete(title);
        sessionStorage.setItem(OPEN_SECTIONS_KEY, JSON.stringify([...list]));
      } catch {
        // Not worth failing the panel over.
      }
      return next;
    });
  };

  // A search hides the headers that match nothing and opens the ones that do,
  // so a query never leaves you clicking through collapsed sections.
  const searching = query.length > 0;
  const body = <div style={{ marginTop: 6 }}>{children}</div>;
  if (searching) {
    const hasHits = Array.isArray(children)
      ? children.some((c) => c !== null && c !== false)
      : children !== null;
    if (!hasHits) return null;
    return (
      <div style={{ borderTop: `1px solid ${LINE}`, paddingTop: 6, marginTop: 6 }}>
        <div style={{ color: AMBER, fontSize: 10 }}>{title}</div>
        {body}
      </div>
    );
  }

  return (
    <div style={{ borderTop: `1px solid ${LINE}`, paddingTop: 6, marginTop: 6 }}>
      <button
        type="button"
        onClick={toggle}
        style={{ ...btn, border: "none", width: "100%", textAlign: "left", color: AMBER, padding: 0 }}
      >
        {open ? "▾" : "▸"} {title}
      </button>
      {open && body}
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

function Pick<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly T[];
  onChange: (next: T) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      style={{ ...btn, width: "100%", cursor: "pointer" }}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

/** One line that says what the world is, so you never have to open a section
 *  to find out what you already changed. */
function signature(w: MockWorld): string {
  const usb = `usb ${w.serial.connectedPort === null ? 0 : 1}/${w.serial.ports.length}`;
  const hue = w.hue.appKey === null ? "hue unpaired" : w.hue.streaming ? "hue stream" : "hue idle";
  const forced = Object.keys(w.forcedCodes).length + w.forcedThrows.length;
  return [
    w.shell.viewport,
    w.shellState.language ?? "en",
    usb,
    hue,
    `wled ${w.wled.devices.length}`,
    `+${w.extraLatencyMs}ms`,
    forced > 0 ? `${forced} forced` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const VIEWPORTS: Record<MockWorld["shell"]["viewport"], { w: number; h: number } | null> = {
  free: null,
  compact: { w: 320, h: 480 },
  "compact-min": { w: 300, h: 420 },
  full: { w: 900, h: 620 },
  "full-min": { w: 800, h: 560 },
};

interface PanelProps {
  onReloadApp: (scenario: ScenarioId) => void;
}

export function DevPanel({ onReloadApp }: PanelProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const world = useSyncExternalStore(subscribe, getWorld);
  const stream = useSyncExternalStore(subscribeToEdgeSignalStream, getEdgeSignalStream);
  // Not derived from the world: a preset is a one-way drop into `shellState`,
  // and the editor writes back over it immediately. Reading the selection back
  // out of the map would make the picker jump to "none" on the first drag.
  const [roomMapPreset, setRoomMapPreset] = useState<RoomMapPresetId>(() =>
    getWorld().shellState.roomMap === undefined ? "none" : "simple",
  );

  // A stream left running past a reload would keep emitting into a tree that
  // no longer has the listeners it was started for.
  useEffect(() => stopEdgeSignalStream, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.code === SUMMON_CODE && event.ctrlKey && event.shiftKey) {
        event.preventDefault();
        setOpen((v) => !v);
        return;
      }
      // Only swallow Escape when the focus is inside the panel. Closing from
      // anywhere ate the app's own dismissable surfaces and read as an app bug.
      if (event.key === "Escape") {
        const target = event.target as Node | null;
        const host = document.getElementById("lumasync-dev-mock-panel");
        if (host !== null && target !== null && host.contains(target)) setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Clamping the app root is the only way 320 px is honestly reachable in a
  // browser: the real resize ends in a window call the mock answers `null`.
  useEffect(() => {
    const root = document.getElementById("root");
    if (root === null) return;
    const size = VIEWPORTS[world.shell.viewport];
    if (size === null) {
      root.style.removeProperty("width");
      root.style.removeProperty("height");
      root.style.removeProperty("outline");
      root.style.removeProperty("transform");
      root.style.removeProperty("overflow");
      return;
    }
    root.style.width = `${size.w}px`;
    root.style.height = `${size.h}px`;
    root.style.outline = "1px solid #78350f";
    root.style.overflow = "hidden";
    // Sizing the root is not enough on its own: the title bar and status bar
    // are `position: fixed` with `left-0 right-0`, so they span the viewport
    // and the clamp looks applied while the app still renders full width. A
    // transform makes the root the containing block for fixed descendants,
    // which is what actually holds them inside the box.
    root.style.transform = "translateZ(0)";
  }, [world.shell.viewport]);

  const q = query.trim().toLowerCase();

  const applyScenario = useCallback(
    (id: ScenarioId, reload: boolean) => {
      clearStoredWorld();
      setWorld(SCENARIOS[id].build());
      if (reload) onReloadApp(id);
    },
    [onReloadApp],
  );

  const edits = useMemo(() => {
    const out: { label: string; revert: () => void }[] = [];
    for (const [cmd, code] of Object.entries(world.forcedCodes)) {
      out.push({
        label: `${cmd} → ${code}`,
        revert: () =>
          mutate((w) => {
            delete w.forcedCodes[cmd];
          }),
      });
    }
    for (const cmd of world.forcedThrows) {
      out.push({
        label: `${cmd} throws`,
        revert: () =>
          mutate((w) => {
            w.forcedThrows = w.forcedThrows.filter((c) => c !== cmd);
          }),
      });
    }
    if (world.extraLatencyMs > 0) {
      out.push({
        label: `+${world.extraLatencyMs}ms`,
        revert: () =>
          mutate((w) => {
            w.extraLatencyMs = 0;
          }),
      });
    }
    if (world.shell.viewport !== "free") {
      out.push({
        label: world.shell.viewport,
        revert: () =>
          mutate((w) => {
            w.shell.viewport = "free";
          }),
      });
    }
    return out;
  }, [world]);

  const nextPortIndex = world.serial.ports.length + 1;
  const nextChannelIndex = world.hue.channels.reduce((m, c) => Math.max(m, c.index), -1) + 1;

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
          <div style={{ color: DIM, margin: "2px 0 4px", lineHeight: 1.4 }}>
            {MOCK_HAS_REAL_IPC
              ? "tauri — fixtures answer, passthrough reaches Rust"
              : "browser — fixtures answer, no backend behind passthrough"}
          </div>
          <div style={{ color: "#a8a29e", fontSize: 10, marginBottom: 6, lineHeight: 1.4 }}>
            {signature(world)}
          </div>

          {edits.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 6 }}>
              {edits.map((e) => (
                <button
                  key={e.label}
                  type="button"
                  onClick={e.revert}
                  title="Revert"
                  style={{ ...btn, borderColor: "#b45309", color: AMBER, fontSize: 9 }}
                >
                  {e.label} ×
                </button>
              ))}
            </div>
          )}

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search — label or ShellState field"
            style={{ ...btn, width: "100%", cursor: "text", marginBottom: 4 }}
          />

          <Row>
            <button type="button" style={{ ...btn, flex: 1 }} onClick={() => onReloadApp(world.scenario)}>
              Reload app
            </button>
            <button
              type="button"
              style={{ ...btn, flex: 1 }}
              onClick={() => {
                if (window.confirm("Discard the composed world and rebuild the scenario?")) {
                  applyScenario(world.scenario, true);
                }
              }}
            >
              Reset world
            </button>
          </Row>

          <Section title={`SCENARIOS · ${SCENARIOS[world.scenario].label}`} query={q}>
            {SCENARIO_IDS.map((id) =>
              q.length > 0 && !`${SCENARIOS[id].label} ${SCENARIOS[id].summary}`.toLowerCase().includes(q) ? null : (
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
              ),
            )}
            <div style={{ color: FAINT, fontSize: 10, lineHeight: 1.35, marginTop: 4 }}>
              A preset replaces the world and reloads. Shift-click swaps it under
              the running app instead — the mode where a response landing after
              its scenario is gone reports itself.
            </div>
          </Section>

          <Section title="SHELL & WINDOW" query={q}>
            <Ctl
              label="Viewport"
              keywords="uiMode compact full window size resize 320 900 clamp"
              reach="live"
              query={q}
            >
              <Pick
                value={world.shell.viewport}
                options={["free", "compact", "compact-min", "full", "full-min"] as const}
                onChange={(v) =>
                  mutate((w) => {
                    w.shell.viewport = v;
                  })
                }
              />
              <div style={{ color: FAINT, fontSize: 9, lineHeight: 1.35, marginTop: 2 }}>
                The real resize ends in a window call the mock answers null, so
                without this compact renders at tab width and looks roomier than
                it is.
              </div>
            </Ctl>

            <Ctl label="uiMode" keywords="uiMode compact full layout" reach="reload" query={q}>
              <Pick
                value={world.shellState.uiMode ?? "full"}
                options={["compact", "full"] as const}
                onChange={(v) =>
                  mutate((w) => {
                    w.shellState = { ...w.shellState, uiMode: v };
                    w.shell.viewport = v === "compact" ? "compact" : "full";
                  })
                }
              />
            </Ctl>

            <Ctl
              label="Language"
              keywords="language i18n tr en turkish locale"
              reach="live"
              query={q}
            >
              <Pick
                value={(world.shellState.language as string) ?? "en"}
                options={["en", "tr"] as const}
                onChange={(v) => {
                  mutate((w) => {
                    w.shellState = { ...w.shellState, language: v };
                  });
                  void import("i18next").then((m) => m.default.changeLanguage(v));
                }}
              />
              <div style={{ color: FAINT, fontSize: 9, lineHeight: 1.35, marginTop: 2 }}>
                TR strings run longer and the parity test structurally cannot
                catch a hardcoded English literal — flipping while looking at a
                screen is the only detector there is.
              </div>
            </Ctl>

            <Ctl label="lastSection" keywords="lastSection boot screen" reach="reload" query={q}>
              <Pick
                value={world.shellState.lastSection ?? "lights"}
                options={["lights", "led-setup", "devices", "room-map", "system"] as const}
                onChange={(v) =>
                  mutate((w) => {
                    w.shellState = { ...w.shellState, lastSection: v };
                  })
                }
              />
            </Ctl>
          </Section>

          <Section title="FIRST RUN" query={q}>
            <Ctl
              label="Onboarding step"
              keywords="onboarding hasCompletedOnboarding first run step wizard"
              reach="reload"
              query={q}
            >
              <Pick
                value="—"
                options={["—", "step 1", "step 2", "step 3", "complete"] as const}
                onChange={(v) =>
                  mutate((w) => {
                    // The step is not persisted: the machine mounts at step 1
                    // and only moves forward, so a step is a recipe over the
                    // fields its guards read, not a field of its own.
                    const base: Record<string, unknown> = {
                      ...w.shellState,
                      hasCompletedOnboarding: false,
                    };
                    if (v === "step 1") {
                      delete base.lightingMode;
                      delete base.ledCalibration;
                      w.serial.connectedPort = null;
                    } else if (v === "step 2") {
                      base.lightingMode = { kind: "ambilight" };
                      delete base.ledCalibration;
                      w.serial.connectedPort = null;
                    } else if (v === "step 3") {
                      base.lightingMode = { kind: "ambilight" };
                      delete base.ledCalibration;
                      w.serial.connectedPort = w.serial.ports[0]?.name ?? null;
                    } else if (v === "complete") {
                      base.hasCompletedOnboarding = true;
                    }
                    w.shellState = base;
                  })
                }
              />
            </Ctl>

            <Ctl label="trayHintShown" keywords="trayHintShown hint tray once" reach="reload" query={q}>
              <Toggle
                on={world.shellState.trayHintShown === true}
                label="Tray hint already seen"
                onClick={() =>
                  mutate((w) => {
                    w.shellState = { ...w.shellState, trayHintShown: !(w.shellState.trayHintShown === true) };
                  })
                }
              />
            </Ctl>
          </Section>

          <Section title={`DEVICES · usb ${world.serial.ports.length} · wled ${world.wled.devices.length}`} query={q}>
            <Ctl label="USB strips" keywords="serial port usb strip vid pid allowlist chip firmware" reach="live" query={q}>
              {world.serial.ports.map((port) => {
                const connected = world.serial.connectedPort === port.name;
                return (
                  <div key={port.name} style={{ border: `1px solid ${LINE}`, padding: 5, marginBottom: 4 }}>
                    <div style={{ color: connected ? AMBER : "#e7e5e4", fontSize: 10 }}>{port.name}</div>
                    <div style={{ color: DIM, fontSize: 9, marginBottom: 4 }}>
                      {port.vid.toString(16)}:{port.pid.toString(16)} ·{" "}
                      {port.supported ? "allowlisted" : "not allowlisted"}
                    </div>
                    <Row>
                      <button
                        type="button"
                        style={{ ...btn, flex: 1, color: connected ? AMBER : "#e7e5e4" }}
                        // Nothing polls the serial status after boot, so
                        // editing the world alone leaves the UI insisting the
                        // cable is still in. `setSerialConnected` publishes on
                        // the same bus a real pair does.
                        onClick={() => setSerialConnected(port.name, !connected)}
                      >
                        {connected ? "Unplug" : "Plug in"}
                      </button>
                      <button
                        type="button"
                        style={btn}
                        onClick={() =>
                          mutate((w) => {
                            w.serial.ports = w.serial.ports.filter((p) => p.name !== port.name);
                            if (w.serial.connectedPort === port.name) w.serial.connectedPort = null;
                          })
                        }
                      >
                        ×
                      </button>
                    </Row>
                    <Pick
                      value={port.chipType}
                      options={["ws2812b-grb", "sk6812-rgbw"] as const}
                      onChange={(v) =>
                        mutate((w) => {
                          const p = w.serial.ports.find((x) => x.name === port.name);
                          if (p !== undefined) p.chipType = v;
                        })
                      }
                    />
                    <div style={{ height: 3 }} />
                    <Pick
                      value={port.firmwareProfile}
                      options={["lumasync-v1", "adalight"] as const}
                      onChange={(v) =>
                        mutate((w) => {
                          const p = w.serial.ports.find((x) => x.name === port.name);
                          if (p !== undefined) p.firmwareProfile = v;
                        })
                      }
                    />
                    <div style={{ height: 3 }} />
                    <Pick
                      value={port.connectOutcome}
                      options={["OK", "FAILED", "PERMISSION_DENIED", "TIMEOUT", "IO_ERROR"] as const}
                      onChange={(v) =>
                        mutate((w) => {
                          const p = w.serial.ports.find((x) => x.name === port.name);
                          if (p !== undefined) p.connectOutcome = v;
                        })
                      }
                    />
                    <div style={{ height: 3 }} />
                    <Toggle
                      on={port.supported}
                      label="On the VID/PID allowlist"
                      onClick={() =>
                        mutate((w) => {
                          const p = w.serial.ports.find((x) => x.name === port.name);
                          if (p !== undefined) p.supported = !p.supported;
                        })
                      }
                    />
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
            </Ctl>

            <Ctl
              label="Boot-time port rejection"
              keywords="PORT_UNSUPPORTED PORT_NOT_FOUND allowlist autoreconnect drop usb target toast"
              reach="live"
              query={q}
            >
              <div style={{ display: "grid", gap: 4 }}>
                {(["PORT_UNSUPPORTED", "PORT_NOT_FOUND"] as const).map((reason) => (
                  <button
                    key={reason}
                    type="button"
                    style={{ ...btn, width: "100%", textAlign: "left" }}
                    disabled={world.serial.ports.length === 0}
                    onClick={() => rejectSerialPort(world.serial.ports[0].name, reason)}
                  >
                    Reject {world.serial.ports[0]?.name ?? "(no port)"} · {reason}
                  </button>
                ))}
              </div>
              <div style={{ color: FAINT, fontSize: 9, lineHeight: 1.35, marginTop: 4 }}>
                Only these two codes mean USB is structurally unavailable for the session, so only
                these drop `usb` from the output targets. A generic connect failure — set it on the
                port above — deliberately takes a different path.
              </div>
            </Ctl>

            <Ctl label="Health check fails at" keywords="health handshake port_visible step" reach="live" query={q}>
              <Pick
                value={world.serial.healthFailsAt ?? "none"}
                options={
                  ["none", "PORT_VISIBLE", "PORT_SUPPORTED", "CONNECT_AND_VERIFY", "HANDSHAKE"] as const
                }
                onChange={(v) =>
                  mutate((w) => {
                    w.serial.healthFailsAt = v === "none" ? null : v;
                  })
                }
              />
            </Ctl>

            <Ctl label="WLED devices" keywords="wled ddp warls protocol port network" reach="live" query={q}>
              {world.wled.devices.map((d) => (
                <div key={d.host} style={{ border: `1px solid ${LINE}`, padding: 5, marginBottom: 4 }}>
                  <Row>
                    <span style={{ flex: 1, fontSize: 10 }}>
                      {d.name} · {d.ledCount}
                    </span>
                    <button
                      type="button"
                      style={btn}
                      onClick={() =>
                        mutate((w) => {
                          w.wled.devices = w.wled.devices.filter((x) => x.host !== d.host);
                          if (w.wled.connectedHost === d.host) w.wled.connectedHost = null;
                        })
                      }
                    >
                      ×
                    </button>
                  </Row>
                  {/* Binding the sink without going through the picker is the
                      only way to reach a WLED-only session in one click, and
                      that session is a distinct code path: the output dock
                      names the panel instead of a port, and mode gating keys
                      on "any local output" rather than on a serial port. */}
                  <Toggle
                    on={world.wled.connectedHost === d.host}
                    label="Bound as the active sink"
                    onClick={() => setWledBound(d.host, world.wled.connectedHost !== d.host)}
                  />
                  <Pick
                    value={d.protocol}
                    options={["ddp", "drgb"] as const}
                    onChange={(v) =>
                      mutate((w) => {
                        const x = w.wled.devices.find((y) => y.host === d.host);
                        if (x !== undefined) x.protocol = v;
                      })
                    }
                  />
                </div>
              ))}
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
            </Ctl>

            <Ctl label="WLED test outcome" keywords="wled test live confirmed unconfirmed" reach="live" query={q}>
              <Pick
                value={world.wled.testOutcome}
                options={
                  ["WLED_TEST_LIVE_CONFIRMED", "WLED_TEST_SENT_UNCONFIRMED", "WLED_TEST_SEND_FAILED"] as const
                }
                onChange={(v) =>
                  mutate((w) => {
                    w.wled.testOutcome = v;
                  })
                }
              />
            </Ctl>
          </Section>

          <Section title={`HUE · ${world.hue.bridges.length} bridge · ${world.hue.channels.length} ch`} query={q}>
            <Ctl label="Bridges" keywords="hue bridge lastHueBridge pair ip" reach="live" query={q}>
              {world.hue.bridges.map((b) => (
                <Row key={b.id}>
                  <span style={{ flex: 1, fontSize: 10 }}>
                    {b.name} · {b.ip}
                  </span>
                  <button
                    type="button"
                    style={btn}
                    onClick={() =>
                      mutate((w) => {
                        w.hue.bridges = w.hue.bridges.filter((x) => x.id !== b.id);
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
            </Ctl>

            <Ctl label="Bridge state" keywords="hue reachable credential key streaming paired" reach="live" query={q}>
              <Toggle
                on={world.hue.reachable}
                label="Reachable"
                onClick={() =>
                  mutate((w) => {
                    w.hue.reachable = !w.hue.reachable;
                  })
                }
              />
              <Toggle
                on={world.hue.credentialValid}
                label="Key accepted"
                onClick={() =>
                  mutate((w) => {
                    w.hue.credentialValid = !w.hue.credentialValid;
                  })
                }
              />
              <Toggle
                on={world.hue.appKey !== null}
                label="Paired"
                onClick={() =>
                  mutate((w) => {
                    w.hue.appKey = w.hue.appKey === null ? "mock-application-key" : null;
                  })
                }
              />
              <Toggle
                on={world.hue.streaming}
                label="Streaming"
                onClick={() =>
                  mutate((w) => {
                    w.hue.streaming = !w.hue.streaming;
                    if (w.hue.streaming) w.hue.everActive = true;
                  })
                }
              />
              <Toggle
                on={world.hue.activeStreamerElsewhere}
                label="Another app owns the stream"
                onClick={() =>
                  mutate((w) => {
                    w.hue.activeStreamerElsewhere = !w.hue.activeStreamerElsewhere;
                    w.hue.activeStreamerReleasesAt = null;
                  })
                }
              />
              <Toggle
                on={world.hue.everActive}
                label="Hue active at least once (telemetry non-null)"
                onClick={() =>
                  mutate((w) => {
                    w.hue.everActive = !w.hue.everActive;
                  })
                }
              />
            </Ctl>

            <Ctl label="Link-button polls left" keywords="hue pairing link button poll" reach="live" query={q}>
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
                style={{ ...btn, width: "100%", cursor: "text" }}
              />
            </Ctl>

            <Ctl label="Channels" keywords="hue channel light area entertainment" reach="live" query={q}>
              {world.hue.channels.map((c) => (
                <Row key={c.index}>
                  <span style={{ color: DIM, width: 18, fontSize: 10 }}>#{c.index}</span>
                  <input
                    value={c.name}
                    onChange={(e) =>
                      mutate((w) => {
                        const x = w.hue.channels.find((y) => y.index === c.index);
                        if (x !== undefined) x.name = e.target.value;
                      })
                    }
                    style={{ ...btn, flex: 1, cursor: "text" }}
                  />
                  <button
                    type="button"
                    style={btn}
                    onClick={() =>
                      mutate((w) => {
                        w.hue.channels = w.hue.channels.filter((y) => y.index !== c.index);
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
                    // Numbered past the highest in use, not by count — the room
                    // map once handed a new light a number another already had.
                    w.hue.channels.push({ index: nextChannelIndex, name: `Light ${nextChannelIndex}` });
                  })
                }
              >
                + Add channel
              </button>
            </Ctl>
          </Section>

          <Section title="SYSTEM" query={q}>
            <Ctl label="Screen recording" keywords="capture permission macos denied screen" reach="live" query={q}>
              <Toggle
                on={world.capture.permissionGranted}
                label="Permitted"
                onClick={() =>
                  mutate((w) => {
                    w.capture.permissionGranted = !w.capture.permissionGranted;
                  })
                }
              />
            </Ctl>
            <Ctl label="Notifications" keywords="notification permission granted denied" reach="live" query={q}>
              <Pick
                value={world.shell.notificationPermission}
                options={["granted", "denied", "prompt"] as const}
                onChange={(v) =>
                  mutate((w) => {
                    w.shell.notificationPermission = v;
                  })
                }
              />
            </Ctl>
            <Ctl label="Autostart" keywords="autostart startupEnabled login" reach="remount" query={q}>
              <Toggle
                on={world.shell.autostartEnabled}
                label="Enabled"
                onClick={() =>
                  mutate((w) => {
                    w.shell.autostartEnabled = !w.shell.autostartEnabled;
                  })
                }
              />
            </Ctl>
            <Ctl label="Store writes" keywords="persist save shellStore failure banner" reach="live" query={q}>
              <Toggle
                on={world.persistFails}
                label="Refuse every write"
                onClick={() =>
                  mutate((w) => {
                    w.persistFails = !w.persistFails;
                  })
                }
              />
            </Ctl>
          </Section>

          <Section title="TELEMETRY" query={q}>
            <Ctl label="Signal state" keywords="telemetry fps queueHealth latency linkConstrained stalled" reach="live" query={q}>
              <Pick
                value="—"
                options={["—", "healthy", "degraded", "stalled", "zero"] as const}
                onChange={(v) =>
                  mutate((w) => {
                    if (v === "healthy") {
                      w.telemetry = { captureFps: 58.4, sendFps: 58.1, queueHealth: "healthy", frameLatencyMs: 4.2, linkConstrained: false, linkMaxFps: 74, lastCaptureErrorCode: null, lastCaptureErrorAtSecs: null };
                    } else if (v === "degraded") {
                      // Materially degrading, which the contract is explicit is
                      // not the same as merely being at capacity.
                      w.telemetry = { captureFps: 58.4, sendFps: 26.0, queueHealth: "warning", frameLatencyMs: 22.5, linkConstrained: true, linkMaxFps: 26, lastCaptureErrorCode: null, lastCaptureErrorAtSecs: null };
                    } else if (v === "stalled") {
                      w.telemetry = { captureFps: 0, sendFps: 0, queueHealth: "critical", frameLatencyMs: 0, linkConstrained: false, linkMaxFps: 0, lastCaptureErrorCode: "AMBILIGHT_CAPTURE_PERMISSION_DENIED", lastCaptureErrorAtSecs: 2 };
                    } else if (v === "zero") {
                      w.telemetry = { captureFps: 0, sendFps: 0, queueHealth: "healthy", frameLatencyMs: 0, linkConstrained: false, linkMaxFps: 0, lastCaptureErrorCode: null, lastCaptureErrorAtSecs: null };
                    }
                  })
                }
              />
              <div style={{ color: FAINT, fontSize: 9, lineHeight: 1.35, marginTop: 2 }}>
                With no USB connected `linkMaxFps` reports the absent sentinel
                rather than a measured zero — the distinction the readout once
                got wrong in a Hue-only session.
              </div>
            </Ctl>
          </Section>

          <Section title="ROOM MAP" query={q}>
            <Ctl
              label="Content"
              keywords="roomMap zone channel placement strip furniture editor legacy gapped"
              reach="reload"
              query={q}
            >
              <Pick
                value={roomMapPreset}
                options={ROOM_MAP_PRESET_IDS}
                onChange={(v) => {
                  setRoomMapPreset(v);
                  mutate((w) => {
                    const built = ROOM_MAP_PRESETS[v].build();
                    w.shellState = { ...w.shellState, roomMap: built };
                  });
                }}
              />
              <div style={{ color: FAINT, fontSize: 9, lineHeight: 1.35, marginTop: 4 }}>
                {ROOM_MAP_PRESETS[roomMapPreset].summary}
              </div>
            </Ctl>
          </Section>

          {/* Events, not commands. A third of what the app reacts to is pushed
              from Rust and never appears as a command result, so without these
              the edge grid, the twin, the tray menu and the update bar are all
              inert no matter which scenario is loaded. */}
          <Section title={`EVENTS${stream.running ? ` · streaming #${stream.frame}` : ""}`} query={q}>
            <Ctl
              label="Edge signal stream"
              keywords="ambilight edge-signal event twin preview frame seq pattern live test"
              reach="live"
              query={q}
            >
              <Toggle
                on={stream.running}
                label={stream.running ? `Emitting at ${1000 / EDGE_SIGNAL_INTERVAL_MS} Hz` : "Stopped"}
                onClick={() =>
                  stream.running
                    ? stopEdgeSignalStream()
                    : startEdgeSignalStream({ pattern: stream.pattern, source: stream.source })
                }
              />
              <Row>
                <span style={{ color: DIM, fontSize: 10, width: 52 }}>pattern</span>
                <Pick
                  value={stream.pattern}
                  options={PICKER_PATTERN_KINDS}
                  onChange={(v) => startEdgeSignalStream({ pattern: v, source: stream.source })}
                />
              </Row>
              <Row>
                <span style={{ color: DIM, fontSize: 10, width: 52 }}>source</span>
                <Pick
                  value={stream.source}
                  options={["live", "test"] as const}
                  onChange={(v) => startEdgeSignalStream({ pattern: stream.pattern, source: v })}
                />
              </Row>
              <Row>
                <span style={{ color: DIM, fontSize: 10, width: 52 }}>drop</span>
                <Pick
                  value={String(stream.dropEveryNthFrame) as "0" | "2" | "3" | "5"}
                  options={["0", "2", "3", "5"] as const}
                  onChange={(v) =>
                    startEdgeSignalStream({
                      pattern: stream.pattern,
                      source: stream.source,
                      dropEveryNthFrame: Number(v),
                    })
                  }
                />
              </Row>
              <div style={{ color: FAINT, fontSize: 9, lineHeight: 1.35, marginTop: 4 }}>
                Frames are sized from the live calibration, so the LED count follows whatever LED
                SETUP holds. `drop` skips every Nth emission while still advancing `seq` — the
                twin should report gaps, not renumber around them.
              </div>
            </Ctl>

            <Ctl
              label="Tray & window"
              keywords="tray menu lights-off resume solid preview close-to-tray startup event"
              reach="live"
              query={q}
            >
              <div style={{ display: "grid", gap: 4 }}>
                {(
                  [
                    [SHELL_EVENTS.TRAY_LIGHTS_OFF, "Tray → Lights off"],
                    [SHELL_EVENTS.TRAY_RESUME_LAST_MODE, "Tray → Resume last mode"],
                    [SHELL_EVENTS.TRAY_SOLID_COLOR, "Tray → Solid colour"],
                    [SHELL_EVENTS.TRAY_SHOW_LED_PREVIEW, "Tray → Show LED preview"],
                    [SHELL_EVENTS.CLOSE_TO_TRAY, "Window → Close to tray"],
                  ] as const
                ).map(([event, label]) => (
                  <button
                    key={event}
                    type="button"
                    style={{ ...btn, width: "100%", textAlign: "left" }}
                    onClick={() => void emitMockEvent(event)}
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  style={{ ...btn, width: "100%", textAlign: "left" }}
                  onClick={() =>
                    void emitMockEvent(
                      SHELL_EVENTS.TRAY_STARTUP_STATE_CHANGED,
                      !world.shell.autostartEnabled,
                    )
                  }
                >
                  Tray → Autostart flipped to {world.shell.autostartEnabled ? "off" : "on"}
                </button>
              </div>
              <div style={{ color: FAINT, fontSize: 9, lineHeight: 1.35, marginTop: 4 }}>
                There is no tray in a browser tab and none of these has an `invoke` behind it, so
                this is the only place the tray handlers can be reached outside a packaged build.
              </div>
            </Ctl>

            <Ctl
              label="Broadcasts"
              keywords="lighting mode-changed updater download progress event popup sync"
              reach="live"
              query={q}
            >
              <div style={{ display: "grid", gap: 4 }}>
                <button
                  type="button"
                  style={{ ...btn, width: "100%", textAlign: "left" }}
                  onClick={() => void emitLightingModeChanged()}
                >
                  Lighting mode changed ({world.lighting.mode.kind})
                </button>
                <button
                  type="button"
                  style={{ ...btn, width: "100%", textAlign: "left" }}
                  onClick={() => void emitUpdateDownload({ withTotal: true })}
                >
                  Update download (3 s, with total)
                </button>
                <button
                  type="button"
                  style={{ ...btn, width: "100%", textAlign: "left" }}
                  onClick={() => void emitUpdateDownload({ withTotal: false })}
                >
                  Update download (no Content-Length)
                </button>
              </div>
              <div style={{ color: FAINT, fontSize: 9, lineHeight: 1.35, marginTop: 4 }}>
                Without a `totalBytes` the bar has to render indeterminate rather than jumping to
                100 %, which otherwise needs a proxy to reproduce.
              </div>
            </Ctl>
          </Section>

          <Section title={`FAULTS · ${Object.keys(world.forcedCodes).length + world.forcedThrows.length}`} query={q}>
            <div style={{ color: FAINT, fontSize: 9, lineHeight: 1.35, marginBottom: 6 }}>
              Commands here never throw — they answer with a status code inside
              a well-formed response, and the UI branches on that. Forcing a
              code exercises the path the app actually takes; forcing a throw is
              the separate IPC-layer failure.
            </div>
            {(Object.keys(OFFERED_CODES) as (keyof typeof OFFERED_CODES)[]).map((cmd) => {
              const codes = OFFERED_CODES[cmd] as readonly string[];
              if (q.length > 0 && !cmd.toLowerCase().includes(q)) return null;
              return (
                <div key={cmd} style={{ marginBottom: 5 }}>
                  <div style={{ color: DIM, fontSize: 9 }}>{cmd}</div>
                  <Pick
                    value={world.forcedCodes[cmd] ?? "—"}
                    options={["—", ...codes] as const}
                    onChange={(v) =>
                      mutate((w) => {
                        if (v === "—") delete w.forcedCodes[cmd];
                        else w.forcedCodes[cmd] = v;
                      })
                    }
                  />
                </div>
              );
            })}
            <Ctl label="Extra latency" keywords="latency delay slow race timing" reach="live" query={q}>
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
              <div style={{ color: FAINT, fontSize: 9, lineHeight: 1.35 }}>
                +{world.extraLatencyMs} ms on every fixture. Raise it to make
                loading states visible and widen the window where a response can
                be overtaken.
              </div>
            </Ctl>
          </Section>

          <Section title="REAL BACKEND EFFECTS" query={q}>
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
                color: MOCK_HAS_REAL_IPC ? "#fca5a5" : FAINT,
                cursor: MOCK_HAS_REAL_IPC ? "pointer" : "not-allowed",
              }}
            >
              Simulate Hue DTLS fault
            </button>
            <div style={{ color: FAINT, fontSize: 9, lineHeight: 1.35, marginTop: 4 }}>
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
