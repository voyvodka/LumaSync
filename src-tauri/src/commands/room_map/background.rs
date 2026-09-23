//! The copied room-map background images: the size-limited copy behind
//! `copy_background_image`, and the startup prune of copies no layer uses.

use std::collections::HashSet;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use log::warn;
use serde_json::Value;

/// Where copied background images live, under the app data dir. The
/// `fs:allow-read-file` capability is scoped to exactly this directory.
pub(crate) const BACKGROUND_DIR: &str = "room-map-backgrounds";

/// The largest background image accepted. The canvas decodes the whole file
/// into the webview, and a floor plan or a phone photo is a few MB. Mirrors
/// `ROOM_MAP_BACKGROUND_MAX_MB` in `src/shared/contracts/roomMap.ts`.
pub(crate) const MAX_BACKGROUND_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// A copy younger than this is never pruned: a dev and a release build share
/// the app data dir, and the other one may be mid-import.
const PRUNE_GRACE: Duration = Duration::from_secs(60 * 60);

fn too_large(bytes: u64) -> String {
    format!(
        "ROOM_MAP_BACKGROUND_TOO_LARGE: {bytes} bytes exceeds the {MAX_BACKGROUND_IMAGE_BYTES} byte limit"
    )
}

/// Copies `src` into `bg_dir` under a random UUID name and returns the new
/// path. The size is checked twice — from the metadata before any I/O, and
/// again while copying, because the file can grow in between.
pub(crate) fn copy_background_into(src: &Path, bg_dir: &Path) -> Result<PathBuf, String> {
    let size = std::fs::metadata(src)
        .map_err(|e| format!("Failed to read background image: {}", e))?
        .len();
    if size > MAX_BACKGROUND_IMAGE_BYTES {
        return Err(too_large(size));
    }

    std::fs::create_dir_all(bg_dir)
        .map_err(|e| format!("Failed to create background dir: {}", e))?;

    // SECURITY: Use a random UUID for the destination filename to prevent
    // path traversal bypasses and accidental overwriting of other background files.
    let mut filename = uuid::Uuid::new_v4().to_string();
    if let Some(ext) = src.extension() {
        if let Some(ext_str) = ext.to_str() {
            filename.push('.');
            filename.push_str(ext_str);
        }
    }

    let dest = bg_dir.join(filename);
    let copied = std::fs::File::open(src)
        .and_then(|file| {
            let mut out = std::fs::File::create(&dest)?;
            std::io::copy(&mut file.take(MAX_BACKGROUND_IMAGE_BYTES + 1), &mut out)
        })
        .map_err(|e| {
            remove_partial(&dest);
            format!("Failed to copy background image: {}", e)
        })?;
    if copied > MAX_BACKGROUND_IMAGE_BYTES {
        remove_partial(&dest);
        return Err(too_large(copied));
    }
    Ok(dest)
}

fn remove_partial(dest: &Path) {
    match std::fs::remove_file(dest) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => warn!("[room-map] could not remove the partial copy {dest:?}: {error}"),
    }
}

/// Copies in `bg_dir` that no layer of the persisted room map names, older
/// than `grace`. `None` unless `shell_state` carries a `roomMap.imageLayers`
/// array: an unreadable or reshaped store must never read as "nothing is
/// referenced", which would delete every background.
fn unreferenced_backgrounds(
    bg_dir: &Path,
    shell_state: &str,
    now: SystemTime,
    grace: Duration,
) -> Option<Vec<PathBuf>> {
    let root: Value = serde_json::from_str(shell_state).ok()?;
    let room_map = root.get("shell-state")?.get("roomMap")?;
    let layers = room_map.get("imageLayers")?.as_array()?;
    // Compared by file name: the stored path is absolute and would stop
    // matching if the app data dir ever moved.
    let referenced: HashSet<OsString> = layers
        .iter()
        .filter_map(|layer| layer.get("path")?.as_str())
        .chain(room_map.get("backgroundImagePath").and_then(Value::as_str))
        .filter_map(|path| Path::new(path).file_name().map(OsString::from))
        .collect();

    let entries = std::fs::read_dir(bg_dir).ok()?;
    Some(
        entries
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter(|entry| !referenced.contains(&entry.file_name()))
            .filter(|entry| {
                entry
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|modified| now.duration_since(modified).ok())
                    .is_some_and(|age| age >= grace)
            })
            .map(|entry| entry.path())
            .collect(),
    )
}

/// Deletes copied backgrounds that no image layer references any more — a
/// removed layer leaves its copy behind. Runs once at startup, never on
/// import: the editor's undo can bring a deleted layer back within a session.
/// See docs/architecture/room-map.md.
pub(crate) fn prune_unreferenced_backgrounds(app_data_dir: &Path) {
    let bg_dir = app_data_dir.join(BACKGROUND_DIR);
    if !bg_dir.is_dir() {
        return;
    }
    let shell_state = match std::fs::read_to_string(app_data_dir.join("shell-state.json")) {
        Ok(raw) => raw,
        Err(error) => {
            warn!("[room-map] background prune skipped: shell-state unreadable: {error}");
            return;
        }
    };
    let Some(orphans) =
        unreferenced_backgrounds(&bg_dir, &shell_state, SystemTime::now(), PRUNE_GRACE)
    else {
        warn!("[room-map] background prune skipped: the persisted room map has no imageLayers");
        return;
    };
    let mut removed = 0usize;
    for path in &orphans {
        match std::fs::remove_file(path) {
            Ok(()) => removed += 1,
            Err(error) => {
                warn!("[room-map] could not remove orphaned background {path:?}: {error}")
            }
        }
    }
    if removed > 0 {
        log::info!("[room-map] removed {removed} orphaned background image(s)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "lumasync-bg-test-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn file_of(dir: &Path, name: &str, len: u64) -> PathBuf {
        let path = dir.join(name);
        std::fs::File::create(&path).unwrap().set_len(len).unwrap();
        path
    }

    #[test]
    fn an_image_at_the_limit_is_copied() {
        let scratch = Scratch::new();
        let src = file_of(&scratch.0, "plan.png", MAX_BACKGROUND_IMAGE_BYTES);
        let bg_dir = scratch.0.join(BACKGROUND_DIR);

        let dest = copy_background_into(&src, &bg_dir).unwrap();

        assert_eq!(dest.parent(), Some(bg_dir.as_path()));
        assert_eq!(dest.extension().and_then(|e| e.to_str()), Some("png"));
        assert_eq!(
            std::fs::metadata(&dest).unwrap().len(),
            MAX_BACKGROUND_IMAGE_BYTES
        );
    }

    #[test]
    fn an_image_past_the_limit_is_refused_with_a_code_and_leaves_nothing() {
        let scratch = Scratch::new();
        let src = file_of(&scratch.0, "huge.png", MAX_BACKGROUND_IMAGE_BYTES + 1);
        let bg_dir = scratch.0.join(BACKGROUND_DIR);

        let error = copy_background_into(&src, &bg_dir).unwrap_err();

        assert!(
            error.starts_with("ROOM_MAP_BACKGROUND_TOO_LARGE: "),
            "got: {error}"
        );
        let left = std::fs::read_dir(&bg_dir).map_or(0, |entries| entries.count());
        assert_eq!(left, 0, "a refused import must not leave a copy behind");
    }

    /// `/dev/zero` reports a size of 0 and never ends: the source that grows
    /// past the metadata check, which only the bounded copy can stop.
    #[cfg(unix)]
    #[test]
    fn a_source_that_outgrows_its_metadata_is_stopped_mid_copy() {
        let scratch = Scratch::new();
        let bg_dir = scratch.0.join(BACKGROUND_DIR);

        let error = copy_background_into(Path::new("/dev/zero"), &bg_dir).unwrap_err();

        assert!(
            error.starts_with("ROOM_MAP_BACKGROUND_TOO_LARGE: "),
            "got: {error}"
        );
        assert_eq!(std::fs::read_dir(&bg_dir).unwrap().count(), 0);
    }

    #[test]
    fn the_limit_matches_the_contract_the_ui_quotes() {
        let contract = include_str!("../../../../src/shared/contracts/roomMap.ts");
        let mb = MAX_BACKGROUND_IMAGE_BYTES / (1024 * 1024);
        assert!(
            contract.contains(&format!("ROOM_MAP_BACKGROUND_MAX_MB = {mb};")),
            "roomMap.ts must quote the same {mb} MB limit"
        );
    }

    fn state_with(paths: &[&str]) -> String {
        let layers: Vec<Value> = paths
            .iter()
            .map(|path| serde_json::json!({ "id": "x", "path": path }))
            .collect();
        serde_json::json!({ "shell-state": { "roomMap": { "imageLayers": layers } } }).to_string()
    }

    fn later() -> SystemTime {
        SystemTime::now() + PRUNE_GRACE + Duration::from_secs(60)
    }

    #[test]
    fn only_unreferenced_copies_past_the_grace_are_pruned() {
        let scratch = Scratch::new();
        let kept = file_of(&scratch.0, "kept.png", 1);
        let legacy = file_of(&scratch.0, "legacy.jpg", 1);
        let orphan = file_of(&scratch.0, "orphan.png", 1);
        std::fs::create_dir(scratch.0.join("nested")).unwrap();
        let mut state: Value = serde_json::from_str(&state_with(&[
            "/some/other/app-data/room-map-backgrounds/kept.png",
        ]))
        .unwrap();
        state["shell-state"]["roomMap"]["backgroundImagePath"] =
            Value::from(legacy.to_string_lossy().into_owned());

        let orphans =
            unreferenced_backgrounds(&scratch.0, &state.to_string(), later(), PRUNE_GRACE).unwrap();

        assert_eq!(orphans, vec![orphan]);
        assert!(kept.exists());
    }

    #[test]
    fn a_fresh_copy_is_inside_the_grace_and_kept() {
        let scratch = Scratch::new();
        file_of(&scratch.0, "just-imported.png", 1);

        let orphans =
            unreferenced_backgrounds(&scratch.0, &state_with(&[]), SystemTime::now(), PRUNE_GRACE)
                .unwrap();

        assert!(orphans.is_empty());
    }

    #[test]
    fn a_store_without_image_layers_prunes_nothing() {
        let scratch = Scratch::new();
        file_of(&scratch.0, "a.png", 1);

        for state in [
            "not json",
            r#"{"shell-state":{}}"#,
            r#"{"shell-state":{"roomMap":{}}}"#,
            r#"{"other-key":{"roomMap":{"imageLayers":[]}}}"#,
        ] {
            assert_eq!(
                unreferenced_backgrounds(&scratch.0, state, later(), PRUNE_GRACE),
                None,
                "{state}"
            );
        }
    }

    #[test]
    fn prune_deletes_orphans_from_the_real_layout() {
        let scratch = Scratch::new();
        let bg_dir = scratch.0.join(BACKGROUND_DIR);
        std::fs::create_dir(&bg_dir).unwrap();
        let kept = file_of(&bg_dir, "kept.png", 1);
        let orphan = file_of(&bg_dir, "orphan.png", 1);
        let old = SystemTime::now() - PRUNE_GRACE - Duration::from_secs(60);
        for path in [&kept, &orphan] {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(old)
                .unwrap();
        }
        std::fs::write(
            scratch.0.join("shell-state.json"),
            state_with(&[kept.to_str().unwrap()]),
        )
        .unwrap();

        prune_unreferenced_backgrounds(&scratch.0);

        assert!(kept.exists());
        assert!(!orphan.exists());
    }
}
