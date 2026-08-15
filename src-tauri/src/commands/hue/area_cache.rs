//! Process-wide, single-flight cache for the entertainment-area snapshot —
//! removes cross-command polling duplication on the IPC side. See
//! docs/architecture/hue.md.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use tokio::sync::Mutex as AsyncMutex;

use super::super::hue_onboarding::{AreaListError, HueEntertainmentArea};

/// Cached result of one `fetch_hue_entertainment_areas` round-trip. Failures
/// are cached too: an unreachable bridge otherwise turns both polling loops
/// into a request storm against a host that is already struggling.
pub(crate) type AreaSnapshot = Result<Vec<HueEntertainmentArea>, AreaListError>;

/// How long a snapshot may be reused — derived from the polling co-firing
/// interval, not tuned. See docs/architecture/hue.md.
pub(crate) const HUE_AREA_CACHE_TTL_MS: u64 = 1_500;

/// Ceiling on distinct `(bridge_ip, username)` slots. One bridge is the norm;
/// the cap only exists so a caller that walks addresses cannot grow the map
/// without bound.
const MAX_SLOTS: usize = 8;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum HueReadFreshness {
    /// Reuse a snapshot younger than the TTL; join an in-flight fetch.
    Cached,
    /// Always perform a real round-trip, without queueing behind a poll.
    Force,
}

struct CacheEntry {
    value: AreaSnapshot,
    /// Time the round-trip was *issued*, not completed — age is measured
    /// conservatively so a slow bridge cannot stretch the effective TTL.
    issued_at: Instant,
    generation: u64,
}

#[derive(Default)]
struct Slot {
    entry: AsyncMutex<Option<CacheEntry>>,
}

static SLOTS: OnceLock<Mutex<HashMap<String, Arc<Slot>>>> = OnceLock::new();
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn lock_slots() -> MutexGuard<'static, HashMap<String, Arc<Slot>>> {
    SLOTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poison| {
            log::error!("Hue area cache mutex was poisoned — recovering from poison guard.");
            poison.into_inner()
        })
}

fn cache_key(bridge_ip: &str, username: &str) -> String {
    format!("{bridge_ip}|{username}")
}

fn slot_for(key: &str) -> Arc<Slot> {
    let mut slots = lock_slots();
    if !slots.contains_key(key) && slots.len() >= MAX_SLOTS {
        slots.clear();
    }
    Arc::clone(slots.entry(key.to_string()).or_default())
}

/// Drop every cached snapshot and invalidate any fetch already in flight.
///
/// Must be called by anything that mutates bridge-side entertainment state —
/// the `entertainment_configuration` activate/deactivate PUTs and re-pairing.
/// Clearing the map (rather than only bumping the generation) means a caller
/// arriving after the mutation opens a fresh slot instead of joining the
/// pre-mutation flight and waiting out its timeout.
pub(crate) fn invalidate_hue_area_cache() {
    GENERATION.fetch_add(1, Ordering::AcqRel);
    lock_slots().clear();
}

/// Read the entertainment-area snapshot for `(bridge_ip, username)`,
/// delegating to `fetch` on a miss.
pub(crate) async fn read_area_snapshot<F, Fut>(
    bridge_ip: &str,
    username: &str,
    freshness: HueReadFreshness,
    fetch: F,
) -> AreaSnapshot
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = AreaSnapshot>,
{
    read_area_snapshot_with_ttl(
        bridge_ip,
        username,
        freshness,
        Duration::from_millis(HUE_AREA_CACHE_TTL_MS),
        fetch,
    )
    .await
}

async fn read_area_snapshot_with_ttl<F, Fut>(
    bridge_ip: &str,
    username: &str,
    freshness: HueReadFreshness,
    ttl: Duration,
    fetch: F,
) -> AreaSnapshot
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = AreaSnapshot>,
{
    let key = cache_key(bridge_ip, username);

    if freshness == HueReadFreshness::Force {
        // A forced read must never queue behind an in-flight poll: the shared
        // bridge client's timeout is 5 s and the caller is either a user
        // action or a stream mutation gate.
        let generation = GENERATION.load(Ordering::Acquire);
        let issued_at = Instant::now();
        let value = fetch().await;
        store_forced(&key, &value, issued_at, generation);
        return value;
    }

    let slot = slot_for(&key);
    // Held across the fetch — this *is* the single-flight gate.
    let mut guard = slot.entry.lock().await;
    let generation = GENERATION.load(Ordering::Acquire);

    if let Some(entry) = guard.as_ref() {
        if entry.generation == generation && entry.issued_at.elapsed() < ttl {
            return entry.value.clone();
        }
    }

    let issued_at = Instant::now();
    let value = fetch().await;

    *guard = if GENERATION.load(Ordering::Acquire) == generation {
        Some(CacheEntry {
            value: value.clone(),
            issued_at,
            generation,
        })
    } else {
        // A mutation landed mid-flight: this result describes the bridge as it
        // was *before* the mutation and must not outlive the call that asked
        // for it.
        None
    };

    value
}

/// Best-effort publish of a forced read. Skipped on lock contention (a poll is
/// mid-flight and will publish its own, newer result) and when a mutation has
/// landed since the fetch was issued.
fn store_forced(key: &str, value: &AreaSnapshot, issued_at: Instant, generation: u64) {
    if GENERATION.load(Ordering::Acquire) != generation {
        return;
    }
    let slot = slot_for(key);
    let Ok(mut guard) = slot.entry.try_lock() else {
        return;
    };
    if guard
        .as_ref()
        .is_some_and(|entry| entry.issued_at > issued_at)
    {
        return;
    }
    *guard = Some(CacheEntry {
        value: value.clone(),
        issued_at,
        generation,
    });
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Arc;

    use super::*;

    /// The cache is process-global, so the tests that assert fetch counts have
    /// to serialise against each other — `invalidate_hue_area_cache` bumps a
    /// shared generation that would otherwise perturb a concurrent test.
    /// Async-aware because every test holds it across awaits.
    static CACHE_TEST_GUARD: AsyncMutex<()> = AsyncMutex::const_new(());

    async fn guard() -> tokio::sync::MutexGuard<'static, ()> {
        CACHE_TEST_GUARD.lock().await
    }

    fn reset() {
        GENERATION.store(0, Ordering::Release);
        lock_slots().clear();
    }

    fn area(id: &str, active_streamer: bool) -> HueEntertainmentArea {
        HueEntertainmentArea {
            id: id.to_string(),
            name: format!("Area {id}"),
            room_name: None,
            channel_count: 3,
            active_streamer,
        }
    }

    fn ids(snapshot: &AreaSnapshot) -> Vec<String> {
        snapshot
            .as_ref()
            .expect("snapshot should be Ok")
            .iter()
            .map(|entry| entry.id.clone())
            .collect()
    }

    #[tokio::test]
    async fn cached_read_reuses_a_snapshot_inside_the_ttl() {
        let _guard = guard().await;
        reset();
        let calls = Arc::new(AtomicUsize::new(0));

        for _ in 0..3 {
            let calls = Arc::clone(&calls);
            let snapshot = read_area_snapshot_with_ttl(
                "192.168.1.50",
                "ttl-user",
                HueReadFreshness::Cached,
                Duration::from_millis(500),
                || async move {
                    calls.fetch_add(1, AtomicOrdering::SeqCst);
                    Ok(vec![area("a", false)])
                },
            )
            .await;
            assert_eq!(ids(&snapshot), vec!["a".to_string()]);
        }

        assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cached_read_refetches_once_the_ttl_expires() {
        let _guard = guard().await;
        reset();
        let calls = Arc::new(AtomicUsize::new(0));

        let read = |ttl| {
            let calls = Arc::clone(&calls);
            read_area_snapshot_with_ttl(
                "192.168.1.51",
                "expiry-user",
                HueReadFreshness::Cached,
                ttl,
                move || async move {
                    calls.fetch_add(1, AtomicOrdering::SeqCst);
                    Ok(vec![area("a", false)])
                },
            )
        };

        let _ = read(Duration::MAX).await;
        let _ = read(Duration::MAX).await;
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);

        let _ = read(Duration::ZERO).await;
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 2);
    }

    #[tokio::test]
    async fn concurrent_cached_readers_coalesce_into_one_fetch() {
        let _guard = guard().await;
        reset();
        let calls = Arc::new(AtomicUsize::new(0));

        let spawn_read = || {
            let calls = Arc::clone(&calls);
            tokio::spawn(async move {
                read_area_snapshot_with_ttl(
                    "192.168.1.52",
                    "flight-user",
                    HueReadFreshness::Cached,
                    Duration::from_millis(500),
                    move || async move {
                        calls.fetch_add(1, AtomicOrdering::SeqCst);
                        // Long enough that every sibling reader is parked on
                        // the slot lock before the leader publishes.
                        tokio::time::sleep(Duration::from_millis(80)).await;
                        Ok(vec![area("a", true)])
                    },
                )
                .await
            })
        };

        let readers = vec![spawn_read(), spawn_read(), spawn_read(), spawn_read()];
        for reader in readers {
            let snapshot = reader.await.expect("reader task should not panic");
            assert_eq!(ids(&snapshot), vec!["a".to_string()]);
        }

        assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn invalidation_drops_a_snapshot_that_is_still_inside_the_ttl() {
        let _guard = guard().await;
        reset();
        let calls = Arc::new(AtomicUsize::new(0));

        let read = || {
            let calls = Arc::clone(&calls);
            read_area_snapshot_with_ttl(
                "192.168.1.53",
                "mutation-user",
                HueReadFreshness::Cached,
                Duration::from_secs(60),
                move || async move {
                    let seq = calls.fetch_add(1, AtomicOrdering::SeqCst);
                    Ok(vec![area(if seq == 0 { "before" } else { "after" }, false)])
                },
            )
        };

        assert_eq!(ids(&read().await), vec!["before".to_string()]);
        invalidate_hue_area_cache();
        assert_eq!(ids(&read().await), vec!["after".to_string()]);
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_fetch_that_straddles_an_invalidation_is_not_published() {
        let _guard = guard().await;
        reset();
        let calls = Arc::new(AtomicUsize::new(0));

        let read = |delay_ms: u64| {
            let calls = Arc::clone(&calls);
            read_area_snapshot_with_ttl(
                "192.168.1.54",
                "straddle-user",
                HueReadFreshness::Cached,
                Duration::from_secs(60),
                move || async move {
                    calls.fetch_add(1, AtomicOrdering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    Ok(vec![area("a", false)])
                },
            )
        };

        let inflight = tokio::spawn(read(80));
        tokio::time::sleep(Duration::from_millis(20)).await;
        // Mutation lands while the fetch is on the wire.
        invalidate_hue_area_cache();
        let _ = inflight.await.expect("in-flight reader should not panic");

        // The straddling result must not have been persisted.
        let _ = read(0).await;
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 2);
    }

    #[tokio::test]
    async fn forced_read_bypasses_a_fresh_snapshot() {
        let _guard = guard().await;
        reset();
        let calls = Arc::new(AtomicUsize::new(0));

        let read = |freshness: HueReadFreshness| {
            let calls = Arc::clone(&calls);
            read_area_snapshot_with_ttl(
                "192.168.1.55",
                "force-user",
                freshness,
                Duration::from_secs(60),
                move || async move {
                    let seq = calls.fetch_add(1, AtomicOrdering::SeqCst);
                    Ok(vec![area(if seq == 0 { "stale" } else { "fresh" }, false)])
                },
            )
        };

        assert_eq!(ids(&read(HueReadFreshness::Cached).await), vec!["stale"]);
        assert_eq!(ids(&read(HueReadFreshness::Force).await), vec!["fresh"]);
        // The forced result is published, so the next cached read reuses it.
        assert_eq!(ids(&read(HueReadFreshness::Cached).await), vec!["fresh"]);
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 2);
    }

    #[tokio::test]
    async fn failures_are_cached_so_an_unreachable_bridge_is_not_hammered() {
        let _guard = guard().await;
        reset();
        let calls = Arc::new(AtomicUsize::new(0));

        for _ in 0..3 {
            let calls = Arc::clone(&calls);
            let snapshot = read_area_snapshot_with_ttl(
                "192.168.1.56",
                "offline-user",
                HueReadFreshness::Cached,
                Duration::from_millis(500),
                || async move {
                    calls.fetch_add(1, AtomicOrdering::SeqCst);
                    Err(AreaListError::Other("bridge unreachable".to_string()))
                },
            )
            .await;
            assert!(matches!(snapshot, Err(AreaListError::Other(_))));
        }

        assert_eq!(calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn slot_map_stays_bounded() {
        let _guard = guard().await;
        reset();

        for index in 0..(MAX_SLOTS * 2) {
            let _ = read_area_snapshot_with_ttl(
                &format!("10.0.0.{index}"),
                "bounded-user",
                HueReadFreshness::Cached,
                Duration::from_millis(500),
                || async { Ok(vec![area("a", false)]) },
            )
            .await;
        }

        assert!(lock_slots().len() <= MAX_SLOTS);
    }
}
