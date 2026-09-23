//! Where bridge certificate pins live: `hue-bridge-pins.json` in the app data
//! dir, not the OS keychain. A pin is not a secret — it needs integrity, and
//! anything able to write that dir already owns the settings file — while a
//! keychain item costs a macOS access prompt per update and is not stored at
//! all where Linux has no Secret Service. See docs/architecture/hue.md.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use log::{info, warn};
use serde::{Deserialize, Serialize};

pub(crate) const PIN_FILE: &str = "hue-bridge-pins.json";

/// What is remembered about one bridge's certificate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PinRecord {
    /// Seen chaining to a Signify root; a certificate that does not is
    /// refused. The fingerprint is the last one seen, kept for the log only.
    SignifySigned(String),
    /// Not Signify-signed; this exact leaf (SHA-256) is the only one accepted.
    Leaf(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum PinKind {
    Signify,
    SelfSigned,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PinEntry {
    kind: PinKind,
    sha256: String,
}

impl From<&PinRecord> for PinEntry {
    fn from(record: &PinRecord) -> Self {
        match record {
            PinRecord::SignifySigned(sha256) => Self {
                kind: PinKind::Signify,
                sha256: sha256.clone(),
            },
            PinRecord::Leaf(sha256) => Self {
                kind: PinKind::SelfSigned,
                sha256: sha256.clone(),
            },
        }
    }
}

impl From<PinEntry> for PinRecord {
    fn from(entry: PinEntry) -> Self {
        match entry.kind {
            PinKind::Signify => Self::SignifySigned(entry.sha256),
            PinKind::SelfSigned => Self::Leaf(entry.sha256),
        }
    }
}

pub(crate) trait PinStore: Send + Sync {
    fn get(&self, bridge_id: &str) -> Option<PinRecord>;
    fn set(&self, bridge_id: &str, record: &PinRecord) -> Result<(), String>;
}

/// The pins file. Reads are tolerant — a missing or unreadable file is "no
/// pins", logged, never an error that could block Hue — and every write
/// replaces the file atomically (temp file, fsync, rename).
pub(crate) struct FilePinStore {
    path: PathBuf,
    /// Loaded on first use; the file is only written through this store.
    pins: Mutex<Option<BTreeMap<String, PinEntry>>>,
}

impl FilePinStore {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            pins: Mutex::new(None),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<BTreeMap<String, PinEntry>>> {
        self.pins
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn load(&self) -> BTreeMap<String, PinEntry> {
        match std::fs::read_to_string(&self.path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|error| {
                warn!(
                    "[hue-tls] {} is unreadable ({error}); starting with no certificate pins",
                    self.path.display()
                );
                BTreeMap::new()
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => {
                warn!(
                    "[hue-tls] could not read {} ({error}); starting with no certificate pins",
                    self.path.display()
                );
                BTreeMap::new()
            }
        }
    }

    fn write(&self, pins: &BTreeMap<String, PinEntry>) -> Result<(), String> {
        use std::io::Write;

        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let body = serde_json::to_string_pretty(pins).map_err(|error| error.to_string())?;
        let temp_path = self
            .path
            .with_extension(format!("{}.tmp", std::process::id()));
        let written = (|| -> std::io::Result<()> {
            let mut file = std::fs::File::create(&temp_path)?;
            file.write_all(body.as_bytes())?;
            file.sync_all()?;
            std::fs::rename(&temp_path, &self.path)
        })();
        written.map_err(|error| {
            let _ = std::fs::remove_file(&temp_path);
            error.to_string()
        })
    }
}

impl PinStore for FilePinStore {
    fn get(&self, bridge_id: &str) -> Option<PinRecord> {
        let mut pins = self.lock();
        pins.get_or_insert_with(|| self.load())
            .get(bridge_id)
            .cloned()
            .map(PinRecord::from)
    }

    fn set(&self, bridge_id: &str, record: &PinRecord) -> Result<(), String> {
        let mut guard = self.lock();
        let pins = guard.get_or_insert_with(|| self.load());
        let previous = pins.insert(bridge_id.to_string(), PinEntry::from(record));
        let written = self.write(pins);
        if written.is_err() {
            // What is held must match what is on disk, or a later write
            // would persist a pin this one failed to.
            match previous {
                Some(entry) => pins.insert(bridge_id.to_string(), entry),
                None => pins.remove(bridge_id),
            };
        }
        written
    }
}

/// Pins held for the process only: tests, and a process with no app data dir.
#[derive(Default)]
pub(crate) struct MemoryPinStore {
    pins: Mutex<BTreeMap<String, PinRecord>>,
}

impl PinStore for MemoryPinStore {
    fn get(&self, bridge_id: &str) -> Option<PinRecord> {
        self.pins
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(bridge_id)
            .cloned()
    }

    fn set(&self, bridge_id: &str, record: &PinRecord) -> Result<(), String> {
        self.pins
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(bridge_id.to_string(), record.clone());
        Ok(())
    }
}

static SHARED_PINS: OnceLock<Arc<dyn PinStore>> = OnceLock::new();

/// Point the process at `<app data dir>/hue-bridge-pins.json`. Called from
/// `lib.rs` setup before any Hue command can run; a later call is ignored.
pub(crate) fn init_pin_store(app_data_dir: PathBuf) {
    let path = app_data_dir.join(PIN_FILE);
    let store: Arc<dyn PinStore> = Arc::new(FilePinStore::new(path.clone()));
    if SHARED_PINS.set(store).is_err() {
        warn!("[hue-tls] pin store already in use — keeping it");
        return;
    }
    info!(
        "[hue-tls] bridge certificate pins live in {}",
        path.display()
    );
}

/// The process-wide pin store. Before `init_pin_store` (tests, or a setup
/// that found no app data dir) pins are held in memory for the process.
pub(crate) fn default_pin_store() -> Arc<dyn PinStore> {
    Arc::clone(SHARED_PINS.get_or_init(|| {
        #[cfg(not(test))]
        warn!("[hue-tls] no pins file configured — certificate pins last for this session only");
        Arc::new(MemoryPinStore::default())
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "lumasync-pins-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn file(&self) -> PathBuf {
            self.0.join(PIN_FILE)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn pins_survive_a_new_store_over_the_same_file_in_the_agreed_shape() {
        let dir = TempDir::new();
        let store = FilePinStore::new(dir.file());
        store
            .set("001788fffe000a01", &PinRecord::Leaf("aa".into()))
            .unwrap();
        store
            .set("001788fffe000b02", &PinRecord::SignifySigned("bb".into()))
            .unwrap();

        let reopened = FilePinStore::new(dir.file());
        assert_eq!(
            reopened.get("001788fffe000a01"),
            Some(PinRecord::Leaf("aa".into()))
        );
        assert_eq!(
            reopened.get("001788fffe000b02"),
            Some(PinRecord::SignifySigned("bb".into()))
        );
        let on_disk: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.file()).unwrap()).unwrap();
        assert_eq!(
            on_disk,
            serde_json::json!({
                "001788fffe000a01": { "kind": "selfSigned", "sha256": "aa" },
                "001788fffe000b02": { "kind": "signify", "sha256": "bb" },
            })
        );
    }

    #[test]
    fn a_write_leaves_no_temp_file_behind() {
        let dir = TempDir::new();
        FilePinStore::new(dir.file())
            .set("001788fffe000a01", &PinRecord::Leaf("aa".into()))
            .unwrap();
        let names: Vec<_> = std::fs::read_dir(&dir.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(PIN_FILE)]);
    }

    #[test]
    fn a_missing_or_corrupt_file_reads_as_no_pins_and_is_replaced_on_write() {
        let dir = TempDir::new();
        assert_eq!(FilePinStore::new(dir.file()).get("001788fffe000a01"), None);

        std::fs::write(dir.file(), "{ not json").unwrap();
        let store = FilePinStore::new(dir.file());
        assert_eq!(store.get("001788fffe000a01"), None);
        store
            .set("001788fffe000a01", &PinRecord::Leaf("aa".into()))
            .unwrap();
        assert_eq!(
            FilePinStore::new(dir.file()).get("001788fffe000a01"),
            Some(PinRecord::Leaf("aa".into()))
        );
    }

    #[test]
    fn a_failed_write_is_reported_and_not_held_in_memory() {
        let dir = TempDir::new();
        // A directory where the file should be: the rename cannot replace it.
        std::fs::create_dir_all(dir.file()).unwrap();
        let store = FilePinStore::new(dir.file());

        assert!(store
            .set("001788fffe000a01", &PinRecord::Leaf("aa".into()))
            .is_err());
        assert_eq!(store.get("001788fffe000a01"), None);
        let names: Vec<_> = std::fs::read_dir(&dir.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(
            names,
            vec![std::ffi::OsString::from(PIN_FILE)],
            "the temp file is removed"
        );
    }
}
