import { useEffect, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import type { UpdaterState } from "./useAutoUpdater";

interface DevUpdaterMenuProps {
  onSetState: (state: UpdaterState) => void;
}

const MOCK_UPDATE = {
  rid: 0,
  available: true,
  currentVersion: "1.2.0",
  version: "1.3.0",
  date: "2026-04-13",
  body: [
    "### Added",
    "- Hue zone multi-bridge stream support",
    "- Compact mode quick color picker (Solid mode)",
    "- Per-display calibration profiles with auto-switch",
    "- Experimental Thread/Matter bridge discovery",
    "### Changed",
    "- Ambilight pipeline rewritten for lower latency",
    "- Updated IBM Plex font bundling for smaller install size",
    "### Fixed",
    "- macOS Sonoma capture permission dialog loop",
    "- FTDI 0x6015 chip Adalight frame sync drift",
    "- Compact mode mode-strip focus ring clipping",
    "- Tray icon dark mode contrast on Windows 11",
  ].join("\n"),
  rawJson: {},
} as unknown as Update;

type StateKey = "available" | "downloading" | "installing" | "error" | "idle";

const PRESETS: Record<StateKey, UpdaterState> = {
  available: { status: "available", update: MOCK_UPDATE },
  downloading: {
    status: "downloading",
    update: MOCK_UPDATE,
    progress: 62,
    downloadedBytes: 8_800_000,
    totalBytes: 14_200_000,
    bytesPerSecond: 2_300_000,
    etaSeconds: 2,
  },
  installing: { status: "installing", update: MOCK_UPDATE },
  error: {
    status: "error",
    message:
      "minisign public key mismatch — downloaded artifact signature does not match repository key. Update aborted, rollback clean.",
  },
  idle: { status: "idle" },
};

const BUTTONS: { key: StateKey; label: string }[] = [
  { key: "available", label: "Available" },
  { key: "downloading", label: "Downloading" },
  { key: "installing", label: "Installing" },
  { key: "error", label: "Error" },
  { key: "idle", label: "Close modal" },
];

/**
 * Dev-only dropdown next to the "Check for updates" button.
 * Lets devs preview the updater modal's 4 visual states without a real endpoint.
 * Rendered only when `import.meta.env.DEV` is true.
 */
export function DevUpdaterMenu({ onSetState }: DevUpdaterMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="shrink-0 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-amber-500 transition-colors hover:bg-amber-500/15 dark:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        title="Preview updater modal states (dev only)"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        dev
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1.5 flex w-40 flex-col gap-0.5 rounded-lg border border-amber-500/30 bg-zinc-900/95 p-1.5 shadow-xl backdrop-blur dark:border-amber-500/30"
        >
          <div className="px-2 pb-1 pt-1 font-mono text-[8px] uppercase tracking-[0.18em] text-amber-400">
            updater preview
          </div>
          {BUTTONS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              role="menuitem"
              onClick={() => {
                onSetState(PRESETS[key]);
                setOpen(false);
              }}
              className="rounded px-2 py-1.5 text-left font-mono text-[10px] uppercase tracking-wider text-zinc-300 transition-colors hover:bg-amber-500/10 hover:text-amber-300 focus-visible:outline-none focus-visible:bg-amber-500/10 focus-visible:text-amber-300"
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
