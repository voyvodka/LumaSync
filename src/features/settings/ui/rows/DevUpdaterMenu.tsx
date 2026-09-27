import { useRef, useState } from "react";

import { RowButton } from "@/shared/ui/SettingRow/SettingRow";
import { Popover } from "@/shared/ui/Popover/Popover";
import type { UpdateMetadata } from "@/shared/contracts/updater";
import type { UpdaterState } from "@/features/updater/useAutoUpdater";
import styles from "./DevUpdaterMenu.module.css";

interface DevUpdaterMenuProps {
  onSetState: (state: UpdaterState) => void;
}

const MOCK_UPDATE: UpdateMetadata = {
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
};

type StateKey = "available" | "downloading" | "installing" | "installError" | "checkError" | "idle";

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
  installError: {
    status: "error",
    phase: "install",
    message:
      "minisign public key mismatch — downloaded artifact signature does not match repository key. Update aborted, rollback clean.",
  },
  checkError: {
    status: "error",
    phase: "check",
    message: "Could not fetch https://github.com/voyvodka/LumaSync/releases/latest/download/latest.json",
  },
  idle: { status: "idle" },
};

// Dev-only, never shipped, so plain English rather than catalogue keys.
const ITEMS: { key: StateKey; label: string }[] = [
  { key: "available", label: "Available" },
  { key: "downloading", label: "Downloading" },
  { key: "installing", label: "Installing" },
  { key: "installError", label: "Install failed" },
  { key: "checkError", label: "Check failed" },
  { key: "idle", label: "Close the prompt" },
];

/**
 * Dev-only: previews each state of the update prompt without a real feed, from a quiet button
 * beside "Check now". The list is the shared popover; its button opens and closes it.
 */
export function DevUpdaterMenu({ onSetState }: DevUpdaterMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <RowButton
        ref={buttonRef}
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Preview the update prompt (dev only)"
      >
        Dev
      </RowButton>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={buttonRef} side="below" width={200} label="Update prompt preview" role="dialog">
        <div className={styles.list}>
          {ITEMS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={styles.item}
              onClick={() => {
                onSetState(PRESETS[key]);
                setOpen(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
