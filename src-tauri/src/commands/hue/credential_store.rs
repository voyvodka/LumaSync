//! Hue credential secret store (v1.5 W2-A1 + W2-A2).
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
//! - `HUE_CREDENTIAL_MIGRATION_OK` — pairing succeeded AND the new
//!   credentials were written into the keychain. Frontend can clear
//!   the legacy plaintext fields safely.
//! - `HUE_CREDENTIAL_MIGRATION_SKIPPED` — credentials already live in
//!   the keychain and match what we just received; no write performed.
//! - `HUE_CREDENTIAL_MIGRATION_FAILED` — keychain write failed; caller
//!   keeps the plaintext fallback so the bridge stays usable.

use log::{debug, info, warn};

/// Service identifier (bundle id) used as the keychain "service" field.
pub(crate) const KEYCHAIN_SERVICE: &str = "com.lumasync.app";

/// Account identifier for the Hue application key (CLIP v2 username).
pub(crate) const KEY_HUE_APP_KEY: &str = "hue-app-key";

/// Account identifier for the Hue clientkey (DTLS PSK, 16 raw bytes / 32 hex chars).
pub(crate) const KEY_HUE_CLIENT_KEY: &str = "hue-client-key";

/// Frontend-visible status codes (mirrors `HUE_STATUS` additions in `hue.ts`).
///
/// `STORE_OK` / `MIGRATION_OK` etc. are part of the published wire
/// contract; they are intentionally unused inside the crate today
/// (consumers go through `MigrationOutcome::status_code` instead) but
/// must stay defined so a future telemetry surface can reference the
/// canonical strings without re-stringifying.
#[allow(dead_code)]
pub mod status {
    pub const STORE_OK: &str = "HUE_CREDENTIAL_STORE_OK";
    pub const STORE_UNAVAILABLE: &str = "HUE_CREDENTIAL_STORE_UNAVAILABLE";
    pub const MIGRATION_OK: &str = "HUE_CREDENTIAL_MIGRATION_OK";
    pub const MIGRATION_SKIPPED: &str = "HUE_CREDENTIAL_MIGRATION_SKIPPED";
    pub const MIGRATION_FAILED: &str = "HUE_CREDENTIAL_MIGRATION_FAILED";
}

/// Backend label surfaced to the optional `credentialStorageBackend` field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialBackend {
    /// OS-native keychain (Keychain / CredMan / Secret Service).
    Keychain,
    /// Legacy plaintext field on `shellStore` — only used as a downgrade-safe fallback.
    PlaintextLegacy,
    /// No persistent backend (test fixtures, CI containers without D-Bus).
    /// Constructed by `default_store()` when the platform has no keychain;
    /// callers handle it transparently via `resolve_hue_credentials`'s
    /// fallback path so they never need to match on this variant directly.
    #[allow(dead_code)]
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

/// Abstract credential store. Tested against `KeychainStore`, `NoopStore`,
/// and the in-memory test double under `tests::InMemoryStore`.
pub trait SecretStore: Send + Sync {
    /// Persist `value` under `account`. Idempotent: existing entry is overwritten.
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    /// Read the value at `account`. `Ok(None)` means "no entry" (NotFound),
    /// distinct from `Err(_)` which means the backend itself is unavailable.
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    /// Delete the entry at `account`. Idempotent: deleting a missing entry is `Ok(())`.
    fn delete(&self, account: &str) -> Result<(), String>;
    /// Backend label for telemetry / `credentialStorageBackend` surface.
    /// Reserved for the runtime-telemetry surface; tests verify
    /// per-impl values today.
    #[allow(dead_code)]
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
// W2-A2 — migration + credential resolver
// ---------------------------------------------------------------------------

/// Outcome of a one-shot migration write into the keychain.
///
/// Frontend uses this to decide whether to clear the legacy plaintext
/// fields (`hueAppKey` / `hueClientKey`) on `shellStore`. The migration is
/// silent (logged but not surfaced as an error toast) so legacy v1.4 users
/// upgrading to v1.5 do not see a pop-up on first launch — the secret
/// just moves under the hood.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MigrationOutcome {
    /// Both keys were written to the keychain. Caller may clear plaintext fields.
    Migrated,
    /// Keychain already held the same values. No write needed; safe to clear plaintext.
    Skipped,
    /// Keychain write failed (or backend unavailable). Caller MUST keep plaintext.
    Failed,
}

impl MigrationOutcome {
    pub fn status_code(&self) -> &'static str {
        match self {
            MigrationOutcome::Migrated => status::MIGRATION_OK,
            MigrationOutcome::Skipped => status::MIGRATION_SKIPPED,
            MigrationOutcome::Failed => status::MIGRATION_FAILED,
        }
    }

    pub fn backend(&self) -> CredentialBackend {
        match self {
            MigrationOutcome::Migrated | MigrationOutcome::Skipped => CredentialBackend::Keychain,
            MigrationOutcome::Failed => CredentialBackend::PlaintextLegacy,
        }
    }
}

/// Migrate a `(username, client_key)` pair into the keychain.
///
/// Idempotent + downgrade-safe:
/// - If the same value is already there → `Skipped` (no write).
/// - If a different value is there → overwritten (Hue treats every pairing
///   as a fresh credential pair, so overwriting with the latest pair is the
///   correct behaviour for re-pair flows).
/// - If the write fails → `Failed`; caller keeps plaintext fallback.
pub fn migrate_hue_credentials_to_keychain(
    store: &dyn SecretStore,
    username: &str,
    client_key: &str,
) -> MigrationOutcome {
    if username.is_empty() || client_key.is_empty() {
        warn!("[hue-cred] migration aborted — empty credential value");
        return MigrationOutcome::Failed;
    }

    // Read existing values; only "true unavailable" backend errors degrade
    // to Failed. `Ok(None)` is the "first migration" happy path.
    let existing_username = store.get(KEY_HUE_APP_KEY).unwrap_or_else(|err| {
        warn!("[hue-cred] migration GET app-key failed ({err})");
        None
    });
    let existing_client_key = store.get(KEY_HUE_CLIENT_KEY).unwrap_or_else(|err| {
        warn!("[hue-cred] migration GET client-key failed ({err})");
        None
    });

    if existing_username.as_deref() == Some(username)
        && existing_client_key.as_deref() == Some(client_key)
    {
        info!("[hue-cred] migration skipped — keychain already holds matching credentials");
        return MigrationOutcome::Skipped;
    }

    if let Err(err) = store.set(KEY_HUE_APP_KEY, username) {
        warn!("[hue-cred] migration SET app-key failed ({err}) — keeping plaintext");
        return MigrationOutcome::Failed;
    }
    if let Err(err) = store.set(KEY_HUE_CLIENT_KEY, client_key) {
        warn!("[hue-cred] migration SET client-key failed ({err}) — keeping plaintext");
        // Roll back the partial write so we never end with mismatched halves.
        let _ = store.delete(KEY_HUE_APP_KEY);
        return MigrationOutcome::Failed;
    }

    info!("[hue-cred] credentials migrated to keychain");
    MigrationOutcome::Migrated
}

/// Resolved Hue credentials returned by `resolve_hue_credentials`.
///
/// `backend` mirrors the source of the values:
/// - `Keychain` — keychain held both keys; the request fallback was unused.
/// - `PlaintextLegacy` — keychain miss / unavailable; using request values.
/// - `Noop` — no backend AND no fallback values; caller must surface
///   `AUTH_INVALID_RE_PAIR_REQUIRED`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedHueCredentials {
    pub username: String,
    pub client_key: String,
    pub backend: CredentialBackend,
}

/// Resolve Hue credentials with keychain-first preference, falling back to
/// the request-supplied values for legacy v1.4 users.
///
/// This is the only credential lookup path that the DTLS connect should
/// use after W2-A2. Returns:
/// - `Some(creds)` from keychain if both keys are present there.
/// - `Some(creds)` from `(fallback_username, fallback_client_key)` when
///   keychain miss but the request carries non-empty values.
/// - `None` only when both sources are empty (re-pair required).
pub fn resolve_hue_credentials(
    store: &dyn SecretStore,
    fallback_username: &str,
    fallback_client_key: &str,
) -> Option<ResolvedHueCredentials> {
    let kc_username = store.get(KEY_HUE_APP_KEY).ok().flatten();
    let kc_client_key = store.get(KEY_HUE_CLIENT_KEY).ok().flatten();

    if let (Some(u), Some(k)) = (kc_username.as_ref(), kc_client_key.as_ref()) {
        if !u.is_empty() && !k.is_empty() {
            debug!("[hue-cred] resolved from keychain");
            return Some(ResolvedHueCredentials {
                username: u.clone(),
                client_key: k.clone(),
                backend: CredentialBackend::Keychain,
            });
        }
    }

    if !fallback_username.is_empty() && !fallback_client_key.is_empty() {
        debug!("[hue-cred] resolved from plaintext fallback (legacy v1.4 user)");
        return Some(ResolvedHueCredentials {
            username: fallback_username.to_string(),
            client_key: fallback_client_key.to_string(),
            backend: CredentialBackend::PlaintextLegacy,
        });
    }

    debug!("[hue-cred] no credentials available — re-pair required");
    None
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// In-memory `SecretStore` used by W2-A2 migration scenarios. Mirrors
    /// the trait surface so we can deterministically test both happy-path
    /// and "set failed" branches without touching the real keychain.
    #[derive(Default)]
    pub struct InMemoryStore {
        inner: std::sync::Mutex<std::collections::HashMap<String, String>>,
        force_set_failure: std::sync::atomic::AtomicBool,
        force_get_failure: std::sync::atomic::AtomicBool,
    }

    impl InMemoryStore {
        pub fn fail_next_set(&self) {
            self.force_set_failure
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        pub fn fail_next_get(&self) {
            self.force_get_failure
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
            if self
                .force_get_failure
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                return Err("forced GET failure for test".into());
            }
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
        assert_eq!(status::MIGRATION_OK, "HUE_CREDENTIAL_MIGRATION_OK");
        assert_eq!(status::MIGRATION_SKIPPED, "HUE_CREDENTIAL_MIGRATION_SKIPPED");
        assert_eq!(status::MIGRATION_FAILED, "HUE_CREDENTIAL_MIGRATION_FAILED");
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

    // ---------------------- W2-A2 migration scenarios ----------------------

    #[test]
    fn migration_writes_both_keys_to_empty_store() {
        let store = InMemoryStore::default();
        let outcome = migrate_hue_credentials_to_keychain(&store, "user-123", "deadbeef");
        assert_eq!(outcome, MigrationOutcome::Migrated);
        assert_eq!(outcome.status_code(), "HUE_CREDENTIAL_MIGRATION_OK");
        assert_eq!(outcome.backend(), CredentialBackend::Keychain);
        assert_eq!(
            store.get(KEY_HUE_APP_KEY).unwrap().as_deref(),
            Some("user-123")
        );
        assert_eq!(
            store.get(KEY_HUE_CLIENT_KEY).unwrap().as_deref(),
            Some("deadbeef")
        );
    }

    #[test]
    fn migration_idempotent_when_values_already_match() {
        let store = InMemoryStore::default();
        let _ = migrate_hue_credentials_to_keychain(&store, "user-123", "deadbeef");
        let outcome = migrate_hue_credentials_to_keychain(&store, "user-123", "deadbeef");
        assert_eq!(outcome, MigrationOutcome::Skipped);
        assert_eq!(outcome.status_code(), "HUE_CREDENTIAL_MIGRATION_SKIPPED");
        assert_eq!(outcome.backend(), CredentialBackend::Keychain);
    }

    #[test]
    fn migration_overwrites_when_values_differ() {
        let store = InMemoryStore::default();
        let _ = migrate_hue_credentials_to_keychain(&store, "old-user", "0011");
        let outcome = migrate_hue_credentials_to_keychain(&store, "new-user", "ffee");
        assert_eq!(outcome, MigrationOutcome::Migrated);
        assert_eq!(
            store.get(KEY_HUE_APP_KEY).unwrap().as_deref(),
            Some("new-user")
        );
        assert_eq!(
            store.get(KEY_HUE_CLIENT_KEY).unwrap().as_deref(),
            Some("ffee")
        );
    }

    #[test]
    fn migration_rejects_empty_values() {
        let store = InMemoryStore::default();
        assert_eq!(
            migrate_hue_credentials_to_keychain(&store, "", "deadbeef"),
            MigrationOutcome::Failed
        );
        assert_eq!(
            migrate_hue_credentials_to_keychain(&store, "user-123", ""),
            MigrationOutcome::Failed
        );
        assert_eq!(store.get(KEY_HUE_APP_KEY).unwrap(), None);
        assert_eq!(store.get(KEY_HUE_CLIENT_KEY).unwrap(), None);
    }

    #[test]
    fn migration_failed_when_set_fails_and_reports_plaintext_backend() {
        let store = InMemoryStore::default();
        store.fail_next_set();
        let outcome = migrate_hue_credentials_to_keychain(&store, "user-123", "deadbeef");
        assert_eq!(outcome, MigrationOutcome::Failed);
        assert_eq!(outcome.status_code(), "HUE_CREDENTIAL_MIGRATION_FAILED");
        assert_eq!(outcome.backend(), CredentialBackend::PlaintextLegacy);
        // First set was the app-key, which failed before any write happened.
        assert_eq!(store.get(KEY_HUE_APP_KEY).unwrap(), None);
        assert_eq!(store.get(KEY_HUE_CLIENT_KEY).unwrap(), None);
    }

    #[test]
    fn migration_rolls_back_partial_write_when_second_set_fails() {
        // Simulate a backend that lets the first SET succeed but blows up
        // on the second one. The migration MUST clean up the orphan
        // app-key entry so we never end with mismatched halves.
        struct FailingSecond {
            inner: InMemoryStore,
            calls: std::sync::atomic::AtomicUsize,
        }
        impl SecretStore for FailingSecond {
            fn set(&self, account: &str, value: &str) -> Result<(), String> {
                let n = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if n == 1 {
                    return Err("KEYCHAIN_SET_FAILED: simulated".into());
                }
                self.inner.set(account, value)
            }
            fn get(&self, account: &str) -> Result<Option<String>, String> {
                self.inner.get(account)
            }
            fn delete(&self, account: &str) -> Result<(), String> {
                self.inner.delete(account)
            }
            fn backend(&self) -> CredentialBackend {
                CredentialBackend::Keychain
            }
        }
        let store = FailingSecond {
            inner: InMemoryStore::default(),
            calls: std::sync::atomic::AtomicUsize::new(0),
        };
        let outcome = migrate_hue_credentials_to_keychain(&store, "user-123", "deadbeef");
        assert_eq!(outcome, MigrationOutcome::Failed);
        // Rollback: the orphan app-key entry was cleaned up.
        assert_eq!(store.inner.get(KEY_HUE_APP_KEY).unwrap(), None);
        assert_eq!(store.inner.get(KEY_HUE_CLIENT_KEY).unwrap(), None);
    }

    // ----------------------- W2-A2 resolver scenarios -----------------------

    #[test]
    fn resolver_prefers_keychain_when_both_keys_present() {
        let store = InMemoryStore::default();
        store.set(KEY_HUE_APP_KEY, "kc-user").unwrap();
        store.set(KEY_HUE_CLIENT_KEY, "kc-key").unwrap();
        let resolved = resolve_hue_credentials(&store, "fb-user", "fb-key").unwrap();
        assert_eq!(resolved.username, "kc-user");
        assert_eq!(resolved.client_key, "kc-key");
        assert_eq!(resolved.backend, CredentialBackend::Keychain);
    }

    #[test]
    fn resolver_falls_back_to_plaintext_for_legacy_v1_4_user() {
        // Legacy v1.4 user: keychain is empty (NoopStore) but plaintext
        // shellStore fields still hold the credentials.
        let store = NoopStore::new();
        let resolved = resolve_hue_credentials(&store, "legacy-user", "legacy-key").unwrap();
        assert_eq!(resolved.username, "legacy-user");
        assert_eq!(resolved.client_key, "legacy-key");
        assert_eq!(resolved.backend, CredentialBackend::PlaintextLegacy);
    }

    #[test]
    fn resolver_returns_none_when_both_sources_empty() {
        let store = NoopStore::new();
        assert!(resolve_hue_credentials(&store, "", "").is_none());
    }

    #[test]
    fn resolver_falls_through_when_keychain_holds_only_one_half() {
        // Defensive: a half-migrated keychain (only app-key, missing
        // client-key) should NOT be considered authoritative — we drop
        // through to the plaintext fallback so the bridge stays usable.
        let store = InMemoryStore::default();
        store.set(KEY_HUE_APP_KEY, "kc-user").unwrap();
        let resolved = resolve_hue_credentials(&store, "fb-user", "fb-key").unwrap();
        assert_eq!(resolved.username, "fb-user");
        assert_eq!(resolved.backend, CredentialBackend::PlaintextLegacy);
    }

    #[test]
    fn resolver_treats_get_failure_as_keychain_miss() {
        // A transient backend error should not crash credential resolution —
        // we degrade to the plaintext fallback (still safer than denying
        // service outright on a flaky D-Bus / locked Keychain).
        let store = InMemoryStore::default();
        store.fail_next_get();
        let resolved = resolve_hue_credentials(&store, "fb-user", "fb-key").unwrap();
        assert_eq!(resolved.backend, CredentialBackend::PlaintextLegacy);
    }
}
