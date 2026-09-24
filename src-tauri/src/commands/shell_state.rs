//! The one owner of `shell-state.json`: every read and write in the process
//! goes through `ShellStateStore`. Design, `.bak` policy and downgrade
//! compatibility: docs/architecture/contracts-and-state.md, "Shell-state
//! ownership".

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use log::{error, info, warn};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use super::hue::hue_config::{HueStartView, PlacementRecord, RoomPlacementView, ZoneFrame};
use super::hue_intensity::LightingSmoothingPreset;
use super::led_calibration::LedCalibrationConfig;
use super::led_output::{ColorCorrectionConfig, FirmwareProfile, LedChipType, LedColorOrder};
use super::lighting_mode::{AmbilightPayload, LightingModeConfig};
use crate::models::room_map::{RoomDimensions, TvAnchorPlacement};

pub const SHELL_STATE_FILE: &str = "shell-state.json";
/// `SHELL_STORE_KEY` in `src/shared/contracts/shell.ts`.
pub const SHELL_STORE_KEY: &str = "shell-state";
/// `SHELL_STATE_CHANGED_EVENT` in `src/shared/contracts/shell.ts`.
pub const SHELL_STATE_CHANGED_EVENT: &str = "shell://state-changed";

const SHELL_STATE_WRITE_FAILED: &str = "SHELL_STATE_WRITE_FAILED";

/// `writerId` on a change Rust made itself. No window holds it, so no window
/// drops the event as its own echo.
pub const RUST_WRITER_ID: &str = "rust";

type StateMap = Map<String, Value>;

// ---------------------------------------------------------------------------
// Typed reads
// ---------------------------------------------------------------------------

/// A copy of the persisted object, read through the accessors below so each
/// key Rust depends on is spelled in exactly one place.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PersistedShellState(StateMap);

impl PersistedShellState {
    /// The object under `shell-state` in a file body, as the loader reads it.
    #[cfg(test)]
    pub fn from_file_json(raw: &str) -> Option<Self> {
        parse_root(raw.as_bytes())
            .ok()
            .and_then(|root| state_of(&root).cloned())
            .map(Self)
    }

    /// `None` for an absent key and for `null`. A value this build cannot
    /// decode is logged rather than treated as absent without a trace.
    fn read<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        read_value(self.0.get(key)?, key)
    }

    pub fn led_calibration(&self) -> Option<LedCalibrationConfig> {
        self.read("ledCalibration")
    }

    /// `lightingMode.ambilight` — the last Ambilight settings the user saved.
    pub fn ambilight(&self) -> Option<AmbilightPayload> {
        read_value(
            self.0.get("lightingMode")?.get("ambilight")?,
            "lightingMode.ambilight",
        )
    }

    /// Clamped as the frontend's normaliser clamps it, so a value an older
    /// build saved still runs rather than failing the mode's range check.
    pub fn color_correction(&self) -> Option<ColorCorrectionConfig> {
        self.read("colorCorrection")
            .map(super::lighting_mode::config_check::clamp_color_correction)
    }

    pub fn firmware_profile(&self) -> Option<FirmwareProfile> {
        self.read("firmwareProfile")
    }

    /// The chip picker persists under `selectedChipType`; the IPC field name
    /// `chipType` is not a shell-state key.
    pub fn chip_type(&self) -> Option<LedChipType> {
        self.read("selectedChipType")
    }

    /// Persisted as `ledColorOrder`; `colorOrder` is only the IPC field name.
    pub fn color_order(&self) -> Option<LedColorOrder> {
        self.read("ledColorOrder")
    }

    pub fn selected_display_id(&self) -> Option<String> {
        self.read("selectedDisplayId")
    }

    pub fn update_channel(&self) -> Option<String> {
        self.read("updateChannel")
    }

    /// Every image path the room map references: `imageLayers[].path` plus the
    /// legacy `backgroundImagePath`. `None` when `roomMap.imageLayers` is not an
    /// array, so a store without a room map never reads as "no image is used".
    pub fn room_map_image_paths(&self) -> Option<Vec<String>> {
        let room_map = self.0.get("roomMap")?;
        let layers = room_map.get("imageLayers")?.as_array()?;
        Some(
            layers
                .iter()
                .filter_map(|layer| layer.get("path")?.as_str())
                .chain(room_map.get("backgroundImagePath").and_then(Value::as_str))
                .map(str::to_owned)
                .collect(),
        )
    }

    /// The LED control popup's centre, in logical px.
    pub fn popup_center(&self) -> Option<(f64, f64)> {
        Some((
            self.read("ledPreviewPopupCenterX")?,
            self.read("ledPreviewPopupCenterY")?,
        ))
    }

    /// The mode last chosen, with the targets saved beside it.
    pub fn lighting_mode(&self) -> Option<LightingModeConfig> {
        self.read("lightingMode")
    }

    /// `lightingMode` as stored, for a write that changes some fields and
    /// must carry the rest through as they are.
    pub fn lighting_mode_object(&self) -> Option<Map<String, Value>> {
        self.0.get("lightingMode")?.as_object().cloned()
    }

    pub fn last_output_targets(&self) -> Option<Vec<String>> {
        self.read("lastOutputTargets")
    }

    pub fn lighting_intensity_preset(&self) -> Option<LightingSmoothingPreset> {
        self.read("lightingIntensityPreset")
    }

    /// Bridge, area and pairing evidence for a Hue start. The legacy keys are
    /// what an install that predates the keychain still has on disk.
    pub fn hue_start_view(&self) -> HueStartView {
        HueStartView {
            bridge_ip: self
                .0
                .get("lastHueBridge")
                .and_then(|bridge| bridge.get("ip"))
                .and_then(|ip| read_value(ip, "lastHueBridge.ip")),
            app_key: self.read("hueAppKey"),
            client_key: self.read("hueClientKey"),
            credential_backend: self.read("credentialStorageBackend"),
            area_id: self.read("lastHueAreaId"),
        }
    }

    /// Only what channel placement and room geometry read out of `roomMap`. A
    /// record this build cannot read is skipped and logged, not fatal to the rest.
    pub fn room_placement_view(&self) -> Option<RoomPlacementView> {
        let room = self.0.get("roomMap")?.as_object()?;
        let records = |key: &str| -> Vec<&Value> {
            room.get(key)
                .and_then(Value::as_array)
                .map(|items| items.iter().collect())
                .unwrap_or_default()
        };
        Some(RoomPlacementView {
            hue_channels: records("hueChannels")
                .into_iter()
                .filter_map(|record| read_value::<PlacementRecord>(record, "roomMap.hueChannels[]"))
                .collect(),
            zones: records("zones")
                .into_iter()
                .filter_map(|record| read_value::<ZoneFrame>(record, "roomMap.zones[]"))
                .collect(),
            tv_anchor: room
                .get("tvAnchor")
                .and_then(|anchor| read_value::<TvAnchorPlacement>(anchor, "roomMap.tvAnchor")),
            dimensions: room
                .get("dimensions")
                .and_then(|dims| read_value::<RoomDimensions>(dims, "roomMap.dimensions")),
        })
    }
}

fn read_value<T: DeserializeOwned>(value: &Value, key: &str) -> Option<T> {
    if value.is_null() {
        return None;
    }
    match T::deserialize(value) {
        Ok(parsed) => Some(parsed),
        Err(error) => {
            warn!("[shell-state] `{key}` is stored in a shape this build cannot read ({error}); ignoring it");
            None
        }
    }
}

/// The persisted state for a Rust reader, or `None` when nothing is stored.
/// Always the in-memory copy — never the file, which only this module touches.
pub fn persisted<R: Runtime>(app: &AppHandle<R>) -> Option<PersistedShellState> {
    app.try_state::<ShellStateStore>()?.persisted()
}

// ---------------------------------------------------------------------------
// Wire shapes — `src/shared/contracts/shell.ts`
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStateSnapshot {
    pub state: Option<StateMap>,
    pub revision: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStateWriteResult {
    pub applied: bool,
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStateChanged {
    pub set: StateMap,
    pub remove: Vec<String>,
    pub revision: u64,
    pub writer_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStatePatchRequest {
    #[serde(default)]
    pub set: StateMap,
    #[serde(default)]
    pub remove: Vec<String>,
    #[serde(default)]
    pub writer_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStateReplaceRequest {
    pub state: StateMap,
    pub expected_revision: u64,
    #[serde(default)]
    pub writer_id: Option<String>,
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

struct Loaded {
    root: StateMap,
    /// Accepted writes since load; the compare-and-swap token for `replace`.
    revision: u64,
    /// Whether the file now on disk may be rotated into `.bak`. A file that
    /// failed to load must never be, or it would overwrite the last good copy.
    disk_is_good: bool,
}

pub struct ShellStateStore {
    /// `None` keeps the state for this process only.
    path: Option<PathBuf>,
    inner: Mutex<Option<Loaded>>,
}

impl ShellStateStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path: Some(path),
            inner: Mutex::new(None),
        }
    }

    pub fn in_memory() -> Self {
        Self {
            path: None,
            inner: Mutex::new(None),
        }
    }

    /// `<app data dir>/shell-state.json`, or memory-only when there is no
    /// app data dir — the app still starts, and says the settings will not stick.
    pub fn for_app<R: Runtime>(app: &AppHandle<R>) -> Self {
        match app.path().app_data_dir() {
            Ok(dir) => {
                let path = dir.join(SHELL_STATE_FILE);
                info!("[shell-state] settings live in {}", path.display());
                Self::new(path)
            }
            Err(error) => {
                error!(
                    "[shell-state] no app data dir ({error}); settings last for this session only"
                );
                Self::in_memory()
            }
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<Loaded>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn with_loaded<T>(&self, f: impl FnOnce(&mut Loaded) -> T) -> T {
        let mut guard = self.lock();
        let loaded = guard.get_or_insert_with(|| load(self.path.as_deref()));
        f(loaded)
    }

    pub fn snapshot(&self) -> ShellStateSnapshot {
        self.with_loaded(|loaded| ShellStateSnapshot {
            state: state_of(&loaded.root).cloned(),
            revision: loaded.revision,
        })
    }

    pub fn persisted(&self) -> Option<PersistedShellState> {
        self.with_loaded(|loaded| state_of(&loaded.root).cloned().map(PersistedShellState))
    }

    /// Merges top-level keys and writes. `notify` runs under the lock, so the
    /// change events leave in the order the writes landed.
    pub fn patch(
        &self,
        set: StateMap,
        remove: Vec<String>,
        writer_id: Option<String>,
        notify: impl FnOnce(&ShellStateChanged),
    ) -> Result<u64, String> {
        self.with_loaded(|loaded| {
            let mut root = loaded.root.clone();
            let state = state_entry(&mut root);
            for (key, value) in &set {
                state.insert(key.clone(), value.clone());
            }
            for key in &remove {
                state.remove(key);
            }
            self.commit(loaded, root)?;
            notify(&ShellStateChanged {
                set,
                remove,
                revision: loaded.revision,
                writer_id,
            });
            Ok(loaded.revision)
        })
    }

    /// Replaces the whole object only if no write landed since `expected_revision`
    /// was read — a concurrent patch is refused, never overwritten.
    pub fn replace(
        &self,
        next: StateMap,
        expected_revision: u64,
        writer_id: Option<String>,
        notify: impl FnOnce(&ShellStateChanged),
    ) -> Result<ShellStateWriteResult, String> {
        self.with_loaded(|loaded| {
            if loaded.revision != expected_revision {
                return Ok(ShellStateWriteResult {
                    applied: false,
                    revision: loaded.revision,
                });
            }
            let previous = state_of(&loaded.root).cloned().unwrap_or_default();
            let set: StateMap = next
                .iter()
                .filter(|(key, value)| previous.get(*key) != Some(*value))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            let remove: Vec<String> = previous
                .keys()
                .filter(|key| !next.contains_key(*key))
                .cloned()
                .collect();

            let mut root = loaded.root.clone();
            root.insert(SHELL_STORE_KEY.to_string(), Value::Object(next));
            self.commit(loaded, root)?;
            notify(&ShellStateChanged {
                set,
                remove,
                revision: loaded.revision,
                writer_id,
            });
            Ok(ShellStateWriteResult {
                applied: true,
                revision: loaded.revision,
            })
        })
    }

    /// Disk first: a failed write leaves memory as it was, so what is held
    /// never runs ahead of what the next launch will read.
    fn commit(&self, loaded: &mut Loaded, root: StateMap) -> Result<(), String> {
        if let Some(path) = &self.path {
            write_state_file(path, &root, loaded.disk_is_good).map_err(|error| {
                error!("[shell-state] could not write {}: {error}", path.display());
                format!("{SHELL_STATE_WRITE_FAILED}: {error}")
            })?;
        }
        loaded.root = root;
        loaded.revision += 1;
        loaded.disk_is_good = true;
        Ok(())
    }
}

fn state_of(root: &StateMap) -> Option<&StateMap> {
    root.get(SHELL_STORE_KEY).and_then(Value::as_object)
}

fn state_entry(root: &mut StateMap) -> &mut StateMap {
    if !matches!(root.get(SHELL_STORE_KEY), Some(Value::Object(_))) {
        root.insert(SHELL_STORE_KEY.to_string(), Value::Object(Map::new()));
    }
    match root.get_mut(SHELL_STORE_KEY) {
        Some(Value::Object(state)) => state,
        _ => unreachable!("inserted as an object above"),
    }
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| SHELL_STATE_FILE.to_string());
    path.with_file_name(format!("{name}{suffix}"))
}

pub fn backup_path(path: &Path) -> PathBuf {
    sibling(path, ".bak")
}

pub fn corrupt_path(path: &Path) -> PathBuf {
    sibling(path, ".corrupt")
}

/// The root object, with `shell-state` (when present) an object too.
fn parse_root(bytes: &[u8]) -> Result<StateMap, String> {
    let root = match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(root)) => root,
        Ok(_) => return Err("the top level is not a JSON object".to_string()),
        Err(error) => return Err(format!("not valid JSON ({error})")),
    };
    match root.get(SHELL_STORE_KEY) {
        Some(Value::Object(_)) | None => Ok(root),
        Some(_) => Err(format!("`{SHELL_STORE_KEY}` is not an object")),
    }
}

fn load(path: Option<&Path>) -> Loaded {
    let fresh = |root: StateMap, disk_is_good: bool| Loaded {
        root,
        revision: 0,
        disk_is_good,
    };
    let Some(path) = path else {
        return fresh(Map::new(), false);
    };

    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        // Deleting the file is how a user resets, so `.bak` is not consulted.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return fresh(Map::new(), false);
        }
        Err(error) => {
            warn!(
                "[shell-state] could not read {} ({error}); trying the backup",
                path.display()
            );
            return fresh(load_backup(path), false);
        }
    };

    match parse_root(&bytes) {
        Ok(root) => fresh(root, true),
        Err(reason) => {
            let aside = corrupt_path(path);
            match replace_file(&aside, &bytes) {
                Ok(()) => warn!(
                    "[shell-state] {} is unreadable: {reason}; kept a copy at {} and trying the backup",
                    path.display(),
                    aside.display()
                ),
                Err(error) => warn!(
                    "[shell-state] {} is unreadable: {reason}; could not keep a copy ({error}); trying the backup",
                    path.display()
                ),
            }
            fresh(load_backup(path), false)
        }
    }
}

fn load_backup(path: &Path) -> StateMap {
    let backup = backup_path(path);
    let outcome = fs::read(&backup)
        .map_err(|error| error.to_string())
        .and_then(|bytes| parse_root(&bytes));
    match outcome {
        Ok(root) => {
            warn!("[shell-state] recovered settings from {}", backup.display());
            root
        }
        Err(reason) => {
            error!(
                "[shell-state] no usable backup at {} ({reason}); starting from defaults",
                backup.display()
            );
            Map::new()
        }
    }
}

/// Byte-compatible with plugin-store's `to_vec_pretty`, so a downgrade reads it.
fn write_state_file(path: &Path, root: &StateMap, rotate_backup: bool) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_vec_pretty(root).map_err(std::io::Error::other)?;
    if rotate_backup {
        // A failed rotation costs the fallback, not the user's write.
        let rotated =
            fs::read(path).and_then(|previous| replace_file(&backup_path(path), &previous));
        if let Err(error) = rotated {
            if error.kind() != std::io::ErrorKind::NotFound {
                warn!(
                    "[shell-state] could not refresh {} ({error}); writing without it",
                    backup_path(path).display()
                );
            }
        }
    }
    replace_file(path, &body)
}

/// Temp file, fsync, rename: a crash leaves the old file or the new one, never half of either.
fn replace_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp = sibling(path, &format!(".{}.tmp", std::process::id()));
    let written = (|| {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written?;
    sync_parent_dir(path);
    Ok(())
}

/// The rename is durable only once the directory entry is; best effort, since
/// the data itself is already on disk.
#[cfg(unix)]
fn sync_parent_dir(path: &Path) {
    if let Some(parent) = path.parent() {
        if let Err(error) = fs::File::open(parent).and_then(|dir| dir.sync_all()) {
            log::debug!("[shell-state] directory fsync skipped: {error}");
        }
    }
}

#[cfg(not(unix))]
fn sync_parent_dir(_path: &Path) {}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// A write Rust makes on its own behalf, announced to every window exactly as
/// a webview's `patch_shell_state` is, so the frontend cache follows it.
pub fn patch_from_rust<R: Runtime>(app: &AppHandle<R>, set: StateMap) -> Result<u64, String> {
    let Some(store) = app.try_state::<ShellStateStore>() else {
        return Err(format!("{SHELL_STATE_WRITE_FAILED}: no shell-state store"));
    };
    store.patch(
        set,
        Vec::new(),
        Some(RUST_WRITER_ID.to_string()),
        |changed| emit_changed(app, changed),
    )
}

fn emit_changed<R: Runtime>(app: &AppHandle<R>, changed: &ShellStateChanged) {
    if let Err(error) = app.emit(SHELL_STATE_CHANGED_EVENT, changed) {
        warn!(
            "[shell-state] could not announce revision {}: {error}",
            changed.revision
        );
    }
}

#[tauri::command]
pub async fn get_shell_state(
    store: State<'_, ShellStateStore>,
) -> Result<ShellStateSnapshot, String> {
    Ok(store.snapshot())
}

/// A window's write: announced, and handed to the lighting runtime, which
/// re-applies the running mode when a setting it reads changed.
fn window_wrote<R: Runtime>(app: &AppHandle<R>, changed: &ShellStateChanged) {
    emit_changed(app, changed);
    let keys = || {
        changed
            .set
            .keys()
            .map(String::as_str)
            .chain(changed.remove.iter().map(String::as_str))
    };
    super::lighting_mode::outputs::note_settings_saved(app, keys());
    super::hue::health::note_settings_saved(app, keys());
}

#[tauri::command]
pub async fn patch_shell_state<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, ShellStateStore>,
    patch: ShellStatePatchRequest,
) -> Result<ShellStateWriteResult, String> {
    let revision = store.patch(patch.set, patch.remove, patch.writer_id, |changed| {
        window_wrote(&app, changed)
    })?;
    Ok(ShellStateWriteResult {
        applied: true,
        revision,
    })
}

#[tauri::command]
pub async fn replace_shell_state<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, ShellStateStore>,
    request: ShellStateReplaceRequest,
) -> Result<ShellStateWriteResult, String> {
    store.replace(
        request.state,
        request.expected_revision,
        request.writer_id,
        |changed| window_wrote(&app, changed),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "lumasync-shell-state-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn file(&self) -> PathBuf {
            self.0.join(SHELL_STATE_FILE)
        }
        fn store(&self) -> ShellStateStore {
            ShellStateStore::new(self.file())
        }
        fn write_raw(&self, path: &Path, body: &str) {
            fs::write(path, body).unwrap();
        }
        fn disk(&self, path: &Path) -> Value {
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn map(value: Value) -> StateMap {
        match value {
            Value::Object(map) => map,
            other => panic!("expected an object, got {other}"),
        }
    }

    fn patch(store: &ShellStateStore, set: Value) -> u64 {
        store
            .patch(map(set), Vec::new(), None, |_| {})
            .expect("patch writes")
    }

    fn state(store: &ShellStateStore) -> Value {
        Value::Object(store.snapshot().state.unwrap_or_default())
    }

    // --- atomic write + format ---------------------------------------------

    #[test]
    fn a_write_lands_in_the_plugin_store_format_and_leaves_no_temp_file() {
        let dir = TempDir::new();
        let store = dir.store();
        patch(&store, json!({ "language": "tr", "windowCenterX": null }));

        let expected = serde_json::to_vec_pretty(&json!({
            "shell-state": { "language": "tr", "windowCenterX": null }
        }))
        .unwrap();
        assert_eq!(fs::read(dir.file()).unwrap(), expected);

        let leftovers: Vec<_> = fs::read_dir(&dir.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );
    }

    #[test]
    fn a_new_store_reads_back_what_the_last_one_wrote() {
        let dir = TempDir::new();
        patch(
            &dir.store(),
            json!({ "lastSection": "devices", "uiMode": "full" }),
        );

        let reopened = dir.store();
        assert_eq!(
            state(&reopened),
            json!({ "lastSection": "devices", "uiMode": "full" })
        );
    }

    #[test]
    fn other_top_level_keys_survive_a_write() {
        let dir = TempDir::new();
        dir.write_raw(
            &dir.file(),
            r#"{ "shell-state": { "language": "en" }, "unrelated": [1, 2] }"#,
        );
        patch(&dir.store(), json!({ "language": "tr" }));

        assert_eq!(
            dir.disk(&dir.file()),
            json!({ "shell-state": { "language": "tr" }, "unrelated": [1, 2] })
        );
    }

    #[test]
    fn remove_deletes_keys_and_set_merges_the_rest() {
        let dir = TempDir::new();
        let store = dir.store();
        patch(
            &store,
            json!({ "hueAppKey": "secret", "hueClientKey": "k", "language": "en" }),
        );
        store
            .patch(
                map(json!({ "credentialStorageBackend": "keychain" })),
                vec!["hueAppKey".into(), "hueClientKey".into()],
                None,
                |_| {},
            )
            .unwrap();

        let expected = json!({ "language": "en", "credentialStorageBackend": "keychain" });
        assert_eq!(state(&store), expected);
        assert_eq!(dir.disk(&dir.file())["shell-state"], expected);
    }

    #[test]
    fn a_failed_write_changes_nothing_in_memory() {
        let dir = TempDir::new();
        // A regular file where the parent directory should be: every write fails.
        let blocker = dir.0.join("not-a-dir");
        fs::write(&blocker, "x").unwrap();
        let store = ShellStateStore::new(blocker.join(SHELL_STATE_FILE));

        let error = store
            .patch(map(json!({ "language": "tr" })), Vec::new(), None, |_| {
                panic!("a failed write must not announce a change")
            })
            .expect_err("the write cannot succeed");
        assert!(error.starts_with("SHELL_STATE_WRITE_FAILED: "), "{error}");
        let snapshot = store.snapshot();
        assert_eq!(snapshot.state, None);
        assert_eq!(snapshot.revision, 0);
    }

    // --- .bak ----------------------------------------------------------------

    #[test]
    fn the_backup_holds_the_previous_good_file() {
        let dir = TempDir::new();
        let store = dir.store();
        patch(&store, json!({ "language": "en" }));
        assert!(
            !backup_path(&dir.file()).exists(),
            "nothing existed to back up before the first write"
        );

        patch(&store, json!({ "language": "tr" }));
        assert_eq!(
            dir.disk(&backup_path(&dir.file())),
            json!({ "shell-state": { "language": "en" } })
        );
        assert_eq!(
            dir.disk(&dir.file()),
            json!({ "shell-state": { "language": "tr" } })
        );
    }

    #[test]
    fn a_corrupt_file_falls_back_to_the_backup_and_is_kept_aside() {
        let dir = TempDir::new();
        dir.write_raw(&dir.file(), r#"{ "shell-state": { "language": "t"#);
        dir.write_raw(
            &backup_path(&dir.file()),
            r#"{ "shell-state": { "language": "tr", "trayHintShown": true } }"#,
        );

        let store = dir.store();
        assert_eq!(
            state(&store),
            json!({ "language": "tr", "trayHintShown": true })
        );
        assert_eq!(
            fs::read_to_string(corrupt_path(&dir.file())).unwrap(),
            r#"{ "shell-state": { "language": "t"#
        );
    }

    #[test]
    fn a_corrupt_file_is_never_rotated_over_the_good_backup() {
        let dir = TempDir::new();
        dir.write_raw(&dir.file(), "garbage");
        let good = r#"{ "shell-state": { "language": "tr" } }"#;
        dir.write_raw(&backup_path(&dir.file()), good);

        let store = dir.store();
        patch(&store, json!({ "uiMode": "full" }));

        assert_eq!(
            fs::read_to_string(backup_path(&dir.file())).unwrap(),
            good,
            "the backup must still be the last good file"
        );
        assert_eq!(
            dir.disk(&dir.file()),
            json!({ "shell-state": { "language": "tr", "uiMode": "full" } })
        );

        // From here on the main file is ours and good, so it rotates normally.
        patch(&store, json!({ "uiMode": "compact" }));
        assert_eq!(
            dir.disk(&backup_path(&dir.file())),
            json!({ "shell-state": { "language": "tr", "uiMode": "full" } })
        );
    }

    #[test]
    fn a_corrupt_file_with_no_usable_backup_starts_empty_without_panicking() {
        for (main, backup) in [
            ("", None),
            ("[1, 2]", None),
            (r#"{ "shell-state": 7 }"#, None),
            ("{ nope", Some("{ also nope")),
        ] {
            let dir = TempDir::new();
            dir.write_raw(&dir.file(), main);
            if let Some(backup) = backup {
                dir.write_raw(&backup_path(&dir.file()), backup);
            }
            let snapshot = dir.store().snapshot();
            assert_eq!(snapshot.state, None, "main={main:?} backup={backup:?}");
            assert_eq!(snapshot.revision, 0);
        }
    }

    #[test]
    fn a_missing_file_starts_empty_even_with_a_backup_beside_it() {
        let dir = TempDir::new();
        dir.write_raw(
            &backup_path(&dir.file()),
            r#"{ "shell-state": { "language": "tr" } }"#,
        );
        assert_eq!(dir.store().snapshot().state, None);
    }

    // --- concurrency + compare-and-swap ---------------------------------------

    #[test]
    fn concurrent_patches_from_two_threads_lose_nothing() {
        let dir = TempDir::new();
        let store = Arc::new(dir.store());
        const PER_THREAD: usize = 40;

        let writers: Vec<_> = ["main", "popup"]
            .into_iter()
            .map(|window| {
                let store = Arc::clone(&store);
                std::thread::spawn(move || {
                    for i in 0..PER_THREAD {
                        patch(&store, json!({ format!("{window}-{i}"): i }));
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }

        let in_memory = state(&store);
        let on_disk = state(&dir.store());
        assert_eq!(in_memory, on_disk);
        for window in ["main", "popup"] {
            for i in 0..PER_THREAD {
                assert_eq!(
                    in_memory[format!("{window}-{i}")],
                    json!(i),
                    "{window}-{i} was lost"
                );
            }
        }
        assert_eq!(store.snapshot().revision, 2 * PER_THREAD as u64);
    }

    #[test]
    fn replace_is_refused_once_another_write_has_landed() {
        let dir = TempDir::new();
        let store = dir.store();
        patch(&store, json!({ "schemaVersion": 5, "windowX": 10 }));
        let read_at = store.snapshot().revision;

        // Another window writes between the read and the migration write-back.
        patch(&store, json!({ "lastSection": "devices" }));

        let outcome = store
            .replace(map(json!({ "schemaVersion": 6 })), read_at, None, |_| {
                panic!("a refused replace must not announce a change")
            })
            .unwrap();
        assert!(!outcome.applied);
        assert_eq!(
            state(&store),
            json!({ "schemaVersion": 5, "windowX": 10, "lastSection": "devices" })
        );
    }

    #[test]
    fn replace_at_the_current_revision_swaps_the_object_and_reports_the_diff() {
        let dir = TempDir::new();
        let store = dir.store();
        patch(
            &store,
            json!({ "schemaVersion": 5, "windowX": 10, "language": "en" }),
        );
        let read_at = store.snapshot().revision;

        let mut announced = None;
        let outcome = store
            .replace(
                map(json!({ "schemaVersion": 6, "language": "en", "windowCenterX": 170 })),
                read_at,
                Some("writer-a".into()),
                |changed| announced = Some(changed.clone()),
            )
            .unwrap();

        assert!(outcome.applied);
        assert_eq!(outcome.revision, read_at + 1);
        assert_eq!(
            dir.disk(&dir.file())["shell-state"],
            json!({ "schemaVersion": 6, "language": "en", "windowCenterX": 170 })
        );
        let announced = announced.expect("an applied replace is announced");
        assert_eq!(
            Value::Object(announced.set),
            json!({ "schemaVersion": 6, "windowCenterX": 170 })
        );
        assert_eq!(announced.remove, vec!["windowX".to_string()]);
        assert_eq!(announced.writer_id.as_deref(), Some("writer-a"));
    }

    // --- typed reads ------------------------------------------------------------

    fn calibration_fixture(total_leds: u16) -> String {
        format!(
            r#"{{
              "shell-state": {{
                "schemaVersion": 1,
                "ledCalibration": {{
                  "templateId": "monitor-34-ultrawide",
                  "counts": {{ "top": 30, "right": 14, "bottom": 0, "left": 15 }},
                  "bottomMissing": 0,
                  "cornerOwnership": "horizontal",
                  "visualPreset": "vivid",
                  "startAnchor": "left-end",
                  "direction": "cw",
                  "totalLeds": {total_leds}
                }}
              }}
            }}"#
        )
    }

    fn persisted(raw: &str) -> Option<PersistedShellState> {
        PersistedShellState::from_file_json(raw)
    }

    #[test]
    fn led_calibration_reads_the_canonical_shape() {
        let parsed = persisted(&calibration_fixture(59))
            .and_then(|s| s.led_calibration())
            .expect("canonical shell-state must yield calibration");
        assert_eq!(parsed.total_leds, 59);
        assert_eq!(parsed.counts.top, 30);
        assert_eq!(parsed.counts.right, 14);
        assert_eq!(parsed.counts.left, 15);
        assert_eq!(parsed.start_anchor, "left-end");
        assert_eq!(parsed.direction, "cw");

        let serialised = serde_json::to_string(&parsed).unwrap();
        assert!(serialised.contains("\"totalLeds\":59"), "{serialised}");
        assert!(
            serialised.contains("\"startAnchor\":\"left-end\""),
            "{serialised}"
        );
    }

    #[test]
    fn led_calibration_refuses_wrong_shapes() {
        // Keys inlined at the top level are not the store layout.
        assert!(persisted(r#"{ "ledCalibration": { "totalLeds": 59 } }"#)
            .and_then(|s| s.led_calibration())
            .is_none());
        assert!(
            persisted(r#"{ "shell-state": { "lastSection": "lights" } }"#)
                .and_then(|s| s.led_calibration())
                .is_none()
        );
        assert!(persisted("{ not json").is_none());
        assert!(persisted("").is_none());
        // `bottomMissing` has no serde default: a record without it is refused whole.
        let missing_field = r#"{
          "shell-state": {
            "ledCalibration": {
              "counts": { "top": 30, "right": 14, "bottom": 0, "left": 15 },
              "cornerOwnership": "horizontal",
              "visualPreset": "vivid",
              "startAnchor": "left-end",
              "direction": "cw",
              "totalLeds": 59
            }
          }
        }"#;
        assert!(persisted(missing_field)
            .and_then(|s| s.led_calibration())
            .is_none());
    }

    #[test]
    fn ambilight_reads_lighting_mode_ambilight() {
        use crate::commands::hue_intensity::LightingSmoothingPreset;
        let raw = r#"{
          "shell-state": {
            "lightingMode": {
              "kind": "ambilight",
              "ambilight": {
                "brightness": 0.42,
                "saturation": 1.7,
                "blackBorderDetection": true,
                "lightingSmoothingPreset": "intense"
              }
            }
          }
        }"#;
        let parsed = persisted(raw)
            .and_then(|s| s.ambilight())
            .expect("canonical shell-state must yield ambilight payload");
        assert!((parsed.brightness - 0.42).abs() < 1e-4);
        assert_eq!(parsed.saturation, Some(1.7));
        assert!(parsed.black_border_detection);
        assert_eq!(
            parsed.lighting_smoothing_preset,
            Some(LightingSmoothingPreset::Intense)
        );

        let solid = r#"{ "shell-state": { "lightingMode": { "kind": "solid",
            "solid": { "r": 255, "g": 0, "b": 0, "brightness": 1 } } } }"#;
        assert!(persisted(solid).and_then(|s| s.ambilight()).is_none());
        assert!(
            persisted(r#"{ "lightingMode": { "ambilight": { "brightness": 1 } } }"#)
                .and_then(|s| s.ambilight())
                .is_none()
        );
    }

    /// The synthetic-test commands build their mode config server-side, so the
    /// encoder settings can only come from here. Reading the wrong key drops an
    /// SK6812 strip onto the WS2812B encoder without any visible error.
    #[test]
    fn output_stamps_read_the_keys_the_frontend_actually_writes() {
        let state = persisted(
            r#"{
            "shell-state": {
                "colorCorrection": {
                    "gammaR": 2.6, "gammaG": 2.4, "gammaB": 2.2,
                    "kelvin": 4000, "saturation": 1.2
                },
                "firmwareProfile": "adalight",
                "selectedChipType": "sk6812-rgbw",
                "ledColorOrder": "bgr"
            }
        }"#,
        )
        .unwrap();
        assert_eq!(state.chip_type(), Some(LedChipType::Sk6812Rgbw));
        assert_eq!(state.firmware_profile(), Some(FirmwareProfile::Adalight));
        assert_eq!(state.color_correction().map(|c| c.kelvin), Some(4000));
        assert_eq!(state.color_order(), Some(LedColorOrder::Bgr));
    }

    /// `chipType` and `colorOrder` are IPC field names, not persisted keys.
    #[test]
    fn output_stamps_ignore_the_ipc_field_names() {
        let state =
            persisted(r#"{"shell-state":{"chipType":"sk6812-rgbw","colorOrder":"bgr"}}"#).unwrap();
        assert_eq!(state.chip_type(), None);
        assert_eq!(state.color_order(), None);
    }

    #[test]
    fn shell_reads_cover_display_channel_and_popup_centre() {
        let state = persisted(
            r#"{ "shell-state": {
                "selectedDisplayId": "display-2",
                "updateChannel": "beta",
                "ledPreviewPopupCenterX": 640.5,
                "ledPreviewPopupCenterY": 400
            } }"#,
        )
        .unwrap();
        assert_eq!(state.selected_display_id().as_deref(), Some("display-2"));
        assert_eq!(state.update_channel().as_deref(), Some("beta"));
        assert_eq!(state.popup_center(), Some((640.5, 400.0)));

        let unplaced = persisted(
            r#"{ "shell-state": { "ledPreviewPopupCenterX": null, "ledPreviewPopupCenterY": 400 } }"#,
        )
        .unwrap();
        assert_eq!(unplaced.popup_center(), None);
        let wrong_type = persisted(r#"{ "shell-state": { "updateChannel": 3 } }"#).unwrap();
        assert_eq!(wrong_type.update_channel(), None);
    }

    /// What the lighting transaction reads to restore a mode and start Hue.
    #[test]
    fn the_lighting_transaction_reads_its_keys() {
        use crate::commands::hue_intensity::LightingSmoothingPreset;
        use crate::commands::lighting_mode::LightingModeKind;
        let state = persisted(
            r#"{ "shell-state": {
                "lightingMode": { "kind": "solid", "targets": ["usb", "hue"],
                    "solid": { "r": 1, "g": 2, "b": 3, "brightness": 0.5 } },
                "lastOutputTargets": ["hue"],
                "lightingIntensityPreset": "intense",
                "lastHueBridge": { "ip": "192.168.1.50", "id": "abc" },
                "lastHueAreaId": "area-1",
                "hueAppKey": "key",
                "credentialStorageBackend": "keychain",
                "roomMap": {
                    "dimensions": { "widthMeters": 4, "depthMeters": 5, "heightMeters": 2.5 },
                    "tvAnchor": { "x": 1, "y": 0, "width": 1.2, "height": 0.1 },
                    "hueChannels": [
                        { "channelIndex": 0, "channelId": 3, "x": 0.1, "y": 0.2, "z": 0 },
                        { "channelIndex": 1, "x": "not a number" }
                    ],
                    "zones": []
                }
            } }"#,
        )
        .unwrap();

        let mode = state.lighting_mode().expect("the saved mode reads");
        assert_eq!(mode.kind, LightingModeKind::Solid);
        assert_eq!(
            mode.targets,
            Some(vec!["usb".to_string(), "hue".to_string()])
        );
        assert_eq!(state.last_output_targets(), Some(vec!["hue".to_string()]));
        assert_eq!(
            state.lighting_intensity_preset(),
            Some(LightingSmoothingPreset::Intense)
        );
        let hue = state.hue_start_view();
        assert_eq!(hue.bridge_ip.as_deref(), Some("192.168.1.50"));
        assert_eq!(hue.area_id.as_deref(), Some("area-1"));
        assert_eq!(hue.app_key.as_deref(), Some("key"));
        assert_eq!(hue.client_key, None);
        assert_eq!(hue.credential_backend.as_deref(), Some("keychain"));
        let room = state.room_placement_view().expect("the room map reads");
        assert_eq!(
            room.hue_channels.len(),
            1,
            "an unreadable record is skipped alone"
        );
        assert!(room.tv_anchor.is_some());
        assert!(room.dimensions.is_some());
    }

    #[test]
    fn a_rust_write_is_announced_like_a_webview_patch() {
        let app = tauri::test::mock_app();
        app.manage(ShellStateStore::in_memory());
        let (tx, rx) = std::sync::mpsc::channel();
        tauri::Listener::listen(&app, SHELL_STATE_CHANGED_EVENT, move |event| {
            let _ = tx.send(event.payload().to_string());
        });

        let mut set = Map::new();
        set.insert("lastOutputTargets".to_string(), json!(["usb"]));
        patch_from_rust(app.handle(), set).unwrap();

        let announced: Value = serde_json::from_str(&rx.recv().unwrap()).unwrap();
        assert_eq!(announced["set"], json!({ "lastOutputTargets": ["usb"] }));
        assert_eq!(announced["writerId"], json!(RUST_WRITER_ID));
        assert_eq!(
            app.state::<ShellStateStore>().snapshot().state.unwrap()["lastOutputTargets"],
            json!(["usb"])
        );
    }

    #[test]
    fn typed_reads_come_from_memory_not_the_file() {
        let dir = TempDir::new();
        let store = dir.store();
        patch(&store, json!({ "selectedDisplayId": "display-1" }));
        dir.write_raw(
            &dir.file(),
            r#"{ "shell-state": { "selectedDisplayId": "edited-by-hand" } }"#,
        );
        assert_eq!(
            store
                .persisted()
                .and_then(|s| s.selected_display_id())
                .as_deref(),
            Some("display-1")
        );
    }
}
