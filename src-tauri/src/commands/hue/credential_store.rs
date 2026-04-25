//! Hue credential secret store (v1.5 W2-A1).
//!
//! Privacy-positive credential storage backed by the OS-native keychain:
//!
//! - **macOS**: Keychain Services via `Security.framework` (`apple-native`)
//! - **Windows**: Credential Manager (`windows-native`)
//! - **Linux**: Secret Service / libsecret over D-Bus (`linux-native`)
//!
//! Falls back to a `NoopStore` when the keychain is genuinely unavailable
//! (CI containers without D-Bus, headless test fixtures). The runtime
//! migration in W2-A2 prefers `KeychainStore`, falls back to the legacy
//! plaintext shellStore fields, and never silently fails — every error
//! collapses onto a coded `CommandStatus` so the Tauri pipeline preserves
//! the project-wide "commands never throw" pattern.
//!
//! ## Key shape
//!
//! Every secret is namespaced under the LumaSync bundle identifier so the
//! macOS Keychain UI shows it grouped under "LumaSync":
//!
//! ```text
//!   service = "com.lumasync.app"
//!   account = "hue-app-key"   |   "hue-client-key"
//! ```
//!
//! Bridge ID is intentionally NOT part of the key. v1.4 / v1.5 LumaSync
//! tracks a single active bridge in `lastHueBridge` — adding bridge ID to
//! the key would force a re-pair every time the user swapped bridges,
//! which is the opposite of what the keychain is for.
//!
//! ## Status codes (frontend contract additive)
//!
//! - `HUE_CREDENTIAL_STORE_OK` — last call (set/get/delete) succeeded.
//! - `HUE_CREDENTIAL_STORE_UNAVAILABLE` — backend cannot be reached
//!   (no D-Bus, no Keychain, locked CredMan, etc). Caller should fall
//!   back to plaintext shellStore.

// W2-A1 scope: surfaces are defined here; W2-A2 wires consumers in
// hue_onboarding (set after pair) and hue/sender (get before DTLS
// connect). The dead-code allow is intentional and removed in W2-A2.
#![allow(dead_code)]

use log::{debug, warn};

/// Service identifier (bundle id) used as the keychain "service" field.
pub(crate) const KEYCHAIN_SERVICE: &str = "com.lumasync.app";

/// Account identifier for the Hue application key (CLIP v2 username).
pub(crate) const KEY_HUE_APP_KEY: &str = "hue-app-key";

/// Account identifier for the Hue clientkey (DTLS PSK, 16 raw bytes / 32 hex chars).
pub(crate) const KEY_HUE_CLIENT_KEY: &str = "hue-client-key";

/// Frontend-visible status codes (mirrors `HUE_STATUS` additions in `hue.ts`).
pub mod status {
    pub const STORE_OK: &str = "HUE_CREDENTIAL_STORE_OK";
    pub const STORE_UNAVAILABLE: &str = "HUE_CREDENTIAL_STORE_UNAVAILABLE";
}

/// Backend label surfaced to the optional `credentialStorageBackend` field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialBackend {
    /// OS-native keychain (Keychain / CredMan / Secret Service).
    Keychain,
    /// Legacy plaintext field on `shellStore` — only used as a downgrade-safe fallback.
    PlaintextLegacy,
    /// No persistent backend (test fixtures, CI containers without D-Bus).
    Noop,
}

impl CredentialBackend {
    /// Stable string identifier consumed by the optional TS `credentialStorageBackend` field.
    pub fn as_str(&self) -> &'static str {
        match self {
            CredentialBackend::Keychain => "keychain",
            CredentialBackend::PlaintextLegacy => "plaintext-legacy",
            CredentialBackend::Noop => "noop",
        }
    }
}

/// Abstract credential store. Tested against `KeychainStore` and `NoopStore`;
/// W2-A2 will add an in-memory test double for migration scenarios.
pub trait SecretStore: Send + Sync {
    /// Persist `value` under `account`. Idempotent: existing entry is overwritten.
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    /// Read the value at `account`. `Ok(None)` means "no entry" (NotFound),
    /// distinct from `Err(_)` which means the backend itself is unavailable.
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    /// Delete the entry at `account`. Idempotent: deleting a missing entry is `Ok(())`.
    fn delete(&self, account: &str) -> Result<(), String>;
    /// Backend label for telemetry / `credentialStorageBackend` surface.
    fn backend(&self) -> CredentialBackend;
}

// ---------------------------------------------------------------------------
// KeychainStore — production backend
// ---------------------------------------------------------------------------

/// Production secret store backed by the OS-native keychain (`keyring` v3).
#[derive(Default)]
pub struct KeychainStore;

impl KeychainStore {
    pub fn new() -> Self {
        Self
    }

    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, account)
            .map_err(|e| format!("KEYCHAIN_ENTRY_FAILED: {e}"))
    }
}

impl SecretStore for KeychainStore {
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        let entry = Self::entry(account)?;
        entry
            .set_password(value)
            .map_err(|e| format!("KEYCHAIN_SET_FAILED: {e}"))?;
        debug!("[hue-cred] keychain SET ok ({account})");
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = Self::entry(account)?;
        match entry.get_password() {
            Ok(value) => {
                debug!("[hue-cred] keychain GET ok ({account})");
                Ok(Some(value))
            }
            // `keyring::Error::NoEntry` is the only "soft" miss — caller falls back to plaintext.
            Err(keyring::Error::NoEntry) => {
                debug!("[hue-cred] keychain GET miss ({account})");
                Ok(None)
            }
            Err(err) => {
                warn!("[hue-cred] keychain GET failed ({account}): {err}");
                Err(format!("KEYCHAIN_GET_FAILED: {err}"))
            }
        }
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = Self::entry(account)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {
                debug!("[hue-cred] keychain DELETE ok/idempotent ({account})");
                Ok(())
            }
            Err(err) => {
                warn!("[hue-cred] keychain DELETE failed ({account}): {err}");
                Err(format!("KEYCHAIN_DELETE_FAILED: {err}"))
            }
        }
    }

    fn backend(&self) -> CredentialBackend {
        CredentialBackend::Keychain
    }
}

// ---------------------------------------------------------------------------
// NoopStore — used when the OS keychain is genuinely unavailable
// ---------------------------------------------------------------------------

/// Sentinel store returned when the platform has no keychain.
/// All calls return `STORE_UNAVAILABLE`-shaped errors; W2-A2 migration
/// falls back to the legacy plaintext fields without crashing the app.
#[derive(Default)]
pub struct NoopStore;

impl NoopStore {
    pub fn new() -> Self {
        Self
    }
}

impl SecretStore for NoopStore {
    fn set(&self, _account: &str, _value: &str) -> Result<(), String> {
        Err(format!("{}: noop backend", status::STORE_UNAVAILABLE))
    }
    fn get(&self, _account: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    fn delete(&self, _account: &str) -> Result<(), String> {
        Ok(())
    }
    fn backend(&self) -> CredentialBackend {
        CredentialBackend::Noop
    }
}

// ---------------------------------------------------------------------------
// Default factory — tries Keychain, falls back to Noop on platform error
// ---------------------------------------------------------------------------

/// Construct the platform-appropriate `SecretStore`.
///
/// Probes `KeychainStore` by attempting to allocate a throwaway entry. If
/// the backend itself is missing (no D-Bus on Linux, sandbox-blocked
/// Keychain on macOS) we degrade to `NoopStore` so the app keeps running
/// on the legacy plaintext fallback.
pub fn default_store() -> Box<dyn SecretStore> {
    let probe = keyring::Entry::new(KEYCHAIN_SERVICE, "__lumasync_probe__");
    match probe {
        Ok(_) => Box::new(KeychainStore::new()),
        Err(err) => {
            warn!(
                "[hue-cred] keychain unavailable on this platform — falling back to noop: {err}"
            );
            Box::new(NoopStore::new())
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// In-memory `SecretStore` used by W2-A2 migration scenarios. Mirrors
    /// the trait surface so we can deterministically test both happy-path
    /// and "set failed" branches without touching the real keychain.
    #[derive(Default)]
    pub struct InMemoryStore {
        inner: std::sync::Mutex<std::collections::HashMap<String, String>>,
        force_set_failure: std::sync::atomic::AtomicBool,
    }

    impl InMemoryStore {
        pub fn fail_next_set(&self) {
            self.force_set_failure
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    impl SecretStore for InMemoryStore {
        fn set(&self, account: &str, value: &str) -> Result<(), String> {
            if self
                .force_set_failure
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                return Err("forced failure for test".into());
            }
            self.inner
                .lock()
                .map_err(|_| "poisoned".to_string())?
                .insert(account.to_string(), value.to_string());
            Ok(())
        }
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self
                .inner
                .lock()
                .map_err(|_| "poisoned".to_string())?
                .get(account)
                .cloned())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.inner
                .lock()
                .map_err(|_| "poisoned".to_string())?
                .remove(account);
            Ok(())
        }
        fn backend(&self) -> CredentialBackend {
            CredentialBackend::Keychain
        }
    }

    #[test]
    fn key_constants_use_lumasync_namespace() {
        assert_eq!(KEYCHAIN_SERVICE, "com.lumasync.app");
        assert_eq!(KEY_HUE_APP_KEY, "hue-app-key");
        assert_eq!(KEY_HUE_CLIENT_KEY, "hue-client-key");
    }

    #[test]
    fn backend_str_labels_are_stable() {
        assert_eq!(CredentialBackend::Keychain.as_str(), "keychain");
        assert_eq!(
            CredentialBackend::PlaintextLegacy.as_str(),
            "plaintext-legacy"
        );
        assert_eq!(CredentialBackend::Noop.as_str(), "noop");
    }

    #[test]
    fn status_codes_are_stable() {
        assert_eq!(status::STORE_OK, "HUE_CREDENTIAL_STORE_OK");
        assert_eq!(status::STORE_UNAVAILABLE, "HUE_CREDENTIAL_STORE_UNAVAILABLE");
    }

    #[test]
    fn noop_store_get_returns_none_set_returns_unavailable() {
        let store = NoopStore::new();
        assert_eq!(store.get(KEY_HUE_APP_KEY).unwrap(), None);
        let err = store.set(KEY_HUE_APP_KEY, "abc").unwrap_err();
        assert!(err.contains("HUE_CREDENTIAL_STORE_UNAVAILABLE"));
        // Delete is a soft no-op so callers can run a unified cleanup.
        assert!(store.delete(KEY_HUE_APP_KEY).is_ok());
        assert_eq!(store.backend(), CredentialBackend::Noop);
    }

    #[test]
    fn in_memory_store_round_trips_and_overwrites() {
        let store = InMemoryStore::default();
        assert_eq!(store.get(KEY_HUE_APP_KEY).unwrap(), None);

        store.set(KEY_HUE_APP_KEY, "abc").unwrap();
        assert_eq!(store.get(KEY_HUE_APP_KEY).unwrap().as_deref(), Some("abc"));

        // Idempotent overwrite — same key, new value.
        store.set(KEY_HUE_APP_KEY, "xyz").unwrap();
        assert_eq!(store.get(KEY_HUE_APP_KEY).unwrap().as_deref(), Some("xyz"));

        store.delete(KEY_HUE_APP_KEY).unwrap();
        assert_eq!(store.get(KEY_HUE_APP_KEY).unwrap(), None);

        // Deleting a missing key is idempotent.
        store.delete(KEY_HUE_APP_KEY).unwrap();
    }

    #[test]
    fn in_memory_store_set_failure_propagates() {
        let store = InMemoryStore::default();
        store.fail_next_set();
        assert!(store.set(KEY_HUE_APP_KEY, "abc").is_err());
        // After consuming the forced-failure flag, the next set succeeds.
        store.set(KEY_HUE_APP_KEY, "abc").unwrap();
        assert_eq!(store.get(KEY_HUE_APP_KEY).unwrap().as_deref(), Some("abc"));
    }

    #[test]
    fn default_store_constructs_some_backend() {
        // We don't assert which backend, only that the factory returns
        // a usable handle (KeychainStore on macOS dev, Noop on bare CI).
        let store = default_store();
        let backend = store.backend();
        assert!(matches!(
            backend,
            CredentialBackend::Keychain | CredentialBackend::Noop
        ));
    }
}
