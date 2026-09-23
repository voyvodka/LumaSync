//! A local HTTPS stand-in for a Hue bridge, for tests that drive the real
//! runtime paths. Every bridge call is `https://{bridge_ip}/…`, so passing
//! `127.0.0.1:<port>` as the bridge address routes them here unchanged. Its
//! certificate is self-signed and names [`TEST_BRIDGE_ID`], so it passes the
//! real certificate check the way an older bridge does: pinned on first use,
//! in the in-memory store tests use instead of the keychain.
//!
//! Readiness cannot be driven this way — `validate_bridge_addr` refuses a
//! loopback address with a port, and that guard stays.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use openssl::ssl::{SslAcceptor, SslMethod, SslVersion};
use serde_json::{json, Value};

use super::bridge_identity::tests::{self_signed, TestCert};

/// The bridge id every `TestBridge` presents.
pub(crate) const TEST_BRIDGE_ID: &str = "001788fffe7e57b1";

#[derive(Clone, Debug)]
pub(crate) struct Recorded {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) body: String,
    pub(crate) at: Instant,
}

impl Recorded {
    pub(crate) fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap_or(serde_json::Value::Null)
    }
}

pub(crate) struct Reply {
    pub(crate) status: u16,
    pub(crate) content_type: &'static str,
    pub(crate) body: String,
    /// Held before answering, to stand in for a slow or silent bridge.
    pub(crate) delay: Duration,
    pub(crate) headers: Vec<(&'static str, String)>,
}

impl Reply {
    pub(crate) fn json(status: u16, body: serde_json::Value) -> Self {
        Self::text(status, body.to_string())
    }

    pub(crate) fn text(status: u16, body: String) -> Self {
        Self {
            status,
            content_type: "application/json",
            body,
            delay: Duration::ZERO,
            headers: Vec::new(),
        }
    }

    pub(crate) fn ok() -> Self {
        Self::json(200, serde_json::json!({ "data": [], "errors": [] }))
    }

    pub(crate) fn after(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }

    pub(crate) fn with_header(mut self, name: &'static str, value: &str) -> Self {
        self.headers.push((name, value.to_string()));
        self
    }
}

type Router = dyn Fn(&str, &str, &str) -> Reply + Send + Sync;

pub(crate) struct TestBridge {
    /// Pass this as `bridge_ip`.
    pub(crate) authority: String,
    seen: Arc<Mutex<Vec<Recorded>>>,
    /// TCP connections accepted, whether or not TLS then completed.
    connections: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl TestBridge {
    /// `route(method, path, body)` answers every request; it is called on the
    /// connection's own thread, so a delayed reply does not hold up the rest.
    pub(crate) fn start<F>(route: F) -> Self
    where
        F: Fn(&str, &str, &str) -> Reply + Send + Sync + 'static,
    {
        Self::serving(Arc::clone(default_acceptor()), route)
    }

    /// Same, presenting `leaf` (and `chain` after it) instead of the default
    /// certificate.
    pub(crate) fn presenting<F>(leaf: &TestCert, chain: &[&TestCert], route: F) -> Self
    where
        F: Fn(&str, &str, &str) -> Reply + Send + Sync + 'static,
    {
        Self::serving(Arc::new(acceptor_for(leaf, chain, None)), route)
    }

    /// Same, but refusing anything above TLS 1.2, as a bridge on older
    /// firmware may — the handshake signature then takes the TLS 1.2 path.
    pub(crate) fn presenting_tls12<F>(leaf: &TestCert, route: F) -> Self
    where
        F: Fn(&str, &str, &str) -> Reply + Send + Sync + 'static,
    {
        Self::serving(
            Arc::new(acceptor_for(leaf, &[], Some(SslVersion::TLS1_2))),
            route,
        )
    }

    fn serving<F>(acceptor: Arc<SslAcceptor>, route: F) -> Self
    where
        F: Fn(&str, &str, &str) -> Reply + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let authority = listener.local_addr().unwrap().to_string();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let route: Arc<Router> = Arc::new(route);
        let (thread_seen, thread_stop, thread_connections) = (
            Arc::clone(&seen),
            Arc::clone(&stop),
            Arc::clone(&connections),
        );
        let handle = std::thread::spawn(move || {
            while !thread_stop.load(Ordering::SeqCst) {
                let Ok((stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                };
                thread_connections.fetch_add(1, Ordering::SeqCst);
                let (seen, route, acceptor) = (
                    Arc::clone(&thread_seen),
                    Arc::clone(&route),
                    Arc::clone(&acceptor),
                );
                std::thread::spawn(move || serve(stream, &acceptor, &seen, route.as_ref()));
            }
        });
        Self {
            authority,
            seen,
            connections,
            stop,
            handle: Some(handle),
        }
    }

    pub(crate) fn requests(&self) -> Vec<Recorded> {
        self.seen.lock().unwrap().clone()
    }

    pub(crate) fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    /// Every PUT whose path starts with `prefix`, in arrival order.
    pub(crate) fn puts_to(&self, prefix: &str) -> Vec<Recorded> {
        self.requests()
            .into_iter()
            .filter(|r| r.method == "PUT" && r.path.starts_with(prefix))
            .collect()
    }
}

impl Drop for TestBridge {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn acceptor_for(leaf: &TestCert, chain: &[&TestCert], max: Option<SslVersion>) -> SslAcceptor {
    let mut builder = SslAcceptor::mozilla_intermediate_v5(SslMethod::tls()).unwrap();
    builder.set_max_proto_version(max).unwrap();
    builder.set_private_key(&leaf.key).unwrap();
    builder.set_certificate(&leaf.cert).unwrap();
    for cert in chain {
        builder.add_extra_chain_cert(cert.cert.clone()).unwrap();
    }
    builder.check_private_key().unwrap();
    builder.build()
}

/// One certificate for every default bridge in the process, so the pin the
/// first test learns holds for the rest.
fn default_acceptor() -> &'static Arc<SslAcceptor> {
    static ACCEPTOR: OnceLock<Arc<SslAcceptor>> = OnceLock::new();
    ACCEPTOR.get_or_init(|| Arc::new(acceptor_for(&self_signed(TEST_BRIDGE_ID), &[], None)))
}

fn serve(stream: TcpStream, acceptor: &SslAcceptor, seen: &Mutex<Vec<Recorded>>, route: &Router) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let Ok(tls) = acceptor.accept(stream) else {
        return;
    };
    let mut reader = BufReader::new(tls);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            return;
        }
        if line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0; content_length];
    if reader.read_exact(&mut body).is_err() {
        return;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let body = String::from_utf8(body).unwrap_or_default();
    seen.lock().unwrap().push(Recorded {
        method: method.clone(),
        path: path.clone(),
        body: body.clone(),
        at: Instant::now(),
    });

    let reply = route(&method, &path, &body);
    std::thread::sleep(reply.delay);
    let mut tls = reader.into_inner();
    let headers = reply
        .headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    let _ = write!(
        tls,
        "HTTP/1.1 {} X\r\n{headers}Content-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        reply.status,
        reply.content_type,
        reply.body.len(),
        reply.body
    );
    let _ = tls.flush();
    let _ = tls.shutdown();
}

// ---------------------------------------------------------------------------
// A bridge with entertainment areas and lights, shaped like CLIP v2
// ---------------------------------------------------------------------------

type LightPutRoute = dyn Fn(&str) -> Reply + Send + Sync;

/// One CLIP v2 light, as `GET /clip/v2/resource/light/{id}` reports it.
/// `mirek: None` is a light in xy mode (`mirek` null, `mirek_valid` false).
pub(crate) fn light_json(on: bool, brightness: f64, mirek: Option<u16>, xy: (f64, f64)) -> Value {
    json!({
        "type": "light",
        "on": { "on": on },
        "dimming": { "brightness": brightness, "min_dim_level": 0.1 },
        "color": { "xy": { "x": xy.0, "y": xy.1 }, "gamut_type": "C" },
        "color_temperature": { "mirek": mirek, "mirek_valid": mirek.is_some() },
        "metadata": { "archetype": "sultan_bulb" },
        "mode": "normal"
    })
}

pub(crate) struct FakeHue {
    pub(crate) bridge: TestBridge,
    /// What the bridge reports for each light; a test edits it to play the
    /// stream (or the bridge's post-stream restore) changing a light.
    lights: Arc<Mutex<HashMap<String, Value>>>,
}

impl FakeHue {
    /// `areas` maps an area id to its lights, each on its own channel and
    /// reached the way a real bridge links them: channel member →
    /// entertainment service → owning device → light service.
    pub(crate) fn start<P>(
        areas: &[(&str, &[&str])],
        lights: &[(&str, Value)],
        put_light: P,
    ) -> Self
    where
        P: Fn(&str) -> Reply + Send + Sync + 'static,
    {
        Self::with_puts(areas, lights, put_light, false)
    }

    /// Like [`FakeHue::start`], but a light PUT the route answers with a 2xx
    /// also changes what the next GET reports, as a real bridge's does.
    pub(crate) fn start_applying_puts<P>(
        areas: &[(&str, &[&str])],
        lights: &[(&str, Value)],
        put_light: P,
    ) -> Self
    where
        P: Fn(&str) -> Reply + Send + Sync + 'static,
    {
        Self::with_puts(areas, lights, put_light, true)
    }

    fn with_puts<P>(
        areas: &[(&str, &[&str])],
        lights: &[(&str, Value)],
        put_light: P,
        apply_puts: bool,
    ) -> Self
    where
        P: Fn(&str) -> Reply + Send + Sync + 'static,
    {
        let areas: HashMap<String, Vec<String>> = areas
            .iter()
            .map(|(area, ids)| {
                (
                    area.to_string(),
                    ids.iter().map(|id| id.to_string()).collect(),
                )
            })
            .collect();
        let table: Arc<Mutex<HashMap<String, Value>>> = Arc::new(Mutex::new(
            lights
                .iter()
                .map(|(id, state)| (id.to_string(), state.clone()))
                .collect(),
        ));
        let put_light: Arc<LightPutRoute> = Arc::new(put_light);
        let route_table = Arc::clone(&table);
        let not_found = || Reply::json(404, json!({ "errors": [{ "description": "not found" }] }));
        let bridge = TestBridge::start(move |method, path, body| {
            let rest = path.strip_prefix("/clip/v2/resource/").unwrap_or_default();
            let (rtype, id) = rest.split_once('/').unwrap_or((rest, ""));
            let data = |item: Value| Reply::json(200, json!({ "errors": [], "data": [item] }));
            match (method, rtype) {
                ("GET", "entertainment_configuration") => match areas.get(id) {
                    Some(ids) => data(json!({
                        "id": id,
                        "channels": ids.iter().enumerate().map(|(index, light)| json!({
                            "channel_id": index,
                            "position": { "x": 0.0, "y": 0.8, "z": 0.0 },
                            "members": [{
                                "service": { "rid": format!("ent-{light}"), "rtype": "entertainment" },
                                "index": 0
                            }]
                        })).collect::<Vec<_>>()
                    })),
                    None => not_found(),
                },
                ("GET", "entertainment") => data(json!({
                    "id": id,
                    "owner": { "rid": format!("dev-{}", id.trim_start_matches("ent-")), "rtype": "device" }
                })),
                ("GET", "device") => data(json!({
                    "id": id,
                    "services": [{ "rid": id.trim_start_matches("dev-"), "rtype": "light" }]
                })),
                ("GET", "light") => match route_table.lock().unwrap().get(id) {
                    Some(state) => data(state.clone()),
                    None => not_found(),
                },
                ("PUT", "entertainment_configuration") => Reply::ok(),
                ("PUT", "light") => {
                    let reply = put_light(id);
                    if apply_puts && (200..300).contains(&reply.status) {
                        let written: Value = serde_json::from_str(body).unwrap_or(Value::Null);
                        if let (Some(state), Some(on)) =
                            (route_table.lock().unwrap().get_mut(id), written.get("on"))
                        {
                            state["on"] = on.clone();
                        }
                    }
                    reply
                }
                _ => not_found(),
            }
        });
        Self {
            bridge,
            lights: table,
        }
    }

    pub(crate) fn set_light(&self, id: &str, state: Value) {
        self.lights.lock().unwrap().insert(id.to_string(), state);
    }

    /// Every restore PUT, as `(light id, body)` in arrival order.
    pub(crate) fn light_puts(&self) -> Vec<(String, Value)> {
        self.bridge
            .puts_to("/clip/v2/resource/light/")
            .into_iter()
            .map(|r| {
                let id = r.path.rsplit('/').next().unwrap_or_default().to_string();
                (id, r.json())
            })
            .collect()
    }
}
