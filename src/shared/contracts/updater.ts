/** Updater commands. Channel selection is reachable only from Rust
 * (`UpdaterBuilder::endpoints`), so check and download both live here rather
 * than on the plugin's JS API — see `docs/architecture/build-and-release.md`. */
import type { CommandStatusOf } from "./status";
import type { UpdateChannel } from "./shell";

export const UPDATER_COMMANDS = {
  /** Resolve the feed for the persisted channel and report what it offers. */
  CHECK_FOR_UPDATE: "check_for_update",
  /** Download and install the update the last check resolved. */
  DOWNLOAD_AND_INSTALL_UPDATE: "download_and_install_update",
} as const;

export type UpdaterCommand = (typeof UPDATER_COMMANDS)[keyof typeof UPDATER_COMMANDS];

/**
 * Tauri event carrying download progress. Emitted only between
 * `download_and_install_update` being called and its response resolving; the
 * command's own status reports the outcome.
 */
export const UPDATER_PROGRESS_EVENT = "updater://download-progress";

export const UPDATER_STATUS = {
  /** A newer version exists on the resolved channel; `update` is populated. */
  UPDATE_AVAILABLE: "UPDATER_UPDATE_AVAILABLE",
  /** The feed answered and offers nothing newer. `update` is null. */
  UP_TO_DATE: "UPDATER_UP_TO_DATE",
  /** The feed could not be reached or parsed — offline, 404, malformed JSON. */
  CHECK_FAILED: "UPDATER_CHECK_FAILED",
  /**
   * The channel's endpoint could not be built into a URL. A programming error
   * rather than a network one, so it is deliberately not folded into
   * `CHECK_FAILED` — the two need different diagnoses.
   */
  ENDPOINT_INVALID: "UPDATER_ENDPOINT_INVALID",
  /** Install was asked for without a preceding successful check. */
  NO_PENDING_UPDATE: "UPDATER_NO_PENDING_UPDATE",
  /**
   * The download completed and the installer was handed off. On most platforms
   * the app is replaced and relaunched, so a frontend may never observe this.
   */
  INSTALL_STARTED: "UPDATER_INSTALL_STARTED",
  /** Download or signature verification failed; nothing was installed. */
  INSTALL_FAILED: "UPDATER_INSTALL_FAILED",
} as const;

export type UpdaterStatusCode = (typeof UPDATER_STATUS)[keyof typeof UPDATER_STATUS];

export type UpdaterCommandStatus = CommandStatusOf<UpdaterStatusCode>;

/** The subset of the plugin's update metadata the shell actually renders. */
export interface UpdateMetadata {
  /** Version offered by the feed. */
  version: string;
  /** Version currently running, so the modal can show both sides. */
  currentVersion: string;
  /** Release notes, rendered by `UpdateModal`'s own parser. */
  body?: string | null;
  /** Publication date as the feed reported it; not parsed by the shell. */
  date?: string | null;
}

/**
 * Response from `check_for_update`.
 *
 * `channel` is echoed back rather than assumed: the frontend reads the store
 * to render its badge, Rust reads the same store to pick the endpoint, and a
 * mismatch between those two reads is exactly the bug this field exposes.
 */
export interface UpdateCheckResponse {
  status: UpdaterCommandStatus;
  channel: UpdateChannel;
  update?: UpdateMetadata | null;
}

export interface UpdateInstallResponse {
  status: UpdaterCommandStatus;
}

/** Payload of {@link UPDATER_PROGRESS_EVENT}. */
export interface UpdateDownloadProgress {
  downloadedBytes: number;
  /** Absent when the server sends no `Content-Length`. */
  totalBytes?: number | null;
  /** True on the final emission, so a consumer can switch to "installing". */
  finished: boolean;
}
