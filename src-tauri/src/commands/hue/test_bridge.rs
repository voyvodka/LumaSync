//! A local HTTPS stand-in for a Hue bridge, for tests that drive the real
//! runtime paths. Every bridge call is `https://{bridge_ip}/…`, so passing
//! `127.0.0.1:<port>` as the bridge address routes them here unchanged. Its
//! certificate is self-signed and names [`TEST_BRIDGE_ID`], so it passes the
//! real certificate check the way an older bridge does: pinned on first use,
//! in the in-memory store tests use instead of the keychain.
//!
//! Readiness cannot be driven this way — `validate_bridge_addr` refuses a
//! loopback address with a port, and that guard stays.

use std::collections::{HashMap, HashSet};
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

/// What a real bridge does once an area leaves entertainment: after `delay`,
/// it puts its own state on these lights — which need not be the state they
/// had before the stream.
#[derive(Clone)]
struct PostStream {
    delay: Duration,
    lights: Vec<(String, Value)>,
}

#[derive(Default)]
struct FakeHueState {
    lights: HashMap<String, Value>,
    /// Areas someone streams to: `action: start` adds one, `stop` removes it.
    active: HashSet<String>,
    post_stream: Option<PostStream>,
    /// Devices that answer a PUT with 404, as one removed from the bridge does.
    removed_devices: HashSet<String>,
    /// Held before answering a read of every light at once.
    bulk_read_delay: Duration,
}

pub(crate) struct FakeHue {
    pub(crate) bridge: TestBridge,
    /// What the bridge reports; a test edits it to play the stream, the
    /// bridge's post-stream restore, or another app taking the area.
    state: Arc<Mutex<FakeHueState>>,
}

impl FakeHue {
    /// `areas` maps an area id to its lights, each on its own channel and
    /// reached the way a real bridge links them: channel member →
    /// entertainment service → owning device → light service. A light PUT
    /// the route answers with a 2xx changes what the next GET reports, as a
    /// real bridge's does.
    pub(crate) fn start<P>(
        areas: &[(&str, &[&str])],
        lights: &[(&str, Value)],
        put_light: P,
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
        let state = Arc::new(Mutex::new(FakeHueState {
            lights: lights
                .iter()
                .map(|(id, state)| (id.to_string(), state.clone()))
                .collect(),
            ..FakeHueState::default()
        }));
        let put_light: Arc<LightPutRoute> = Arc::new(put_light);
        let route_state = Arc::clone(&state);
        let bridge = TestBridge::start(move |method, path, body| {
            route(&route_state, &areas, put_light.as_ref(), method, path, body)
        });
        Self { bridge, state }
    }

    pub(crate) fn set_light(&self, id: &str, state: Value) {
        self.state
            .lock()
            .unwrap()
            .lights
            .insert(id.to_string(), state);
    }

    pub(crate) fn light(&self, id: &str) -> Value {
        self.state.lock().unwrap().lights[id].clone()
    }

    /// From now on, every `action: stop` makes the bridge put `lights` on
    /// after `delay`, the way a BSB002 was measured doing.
    pub(crate) fn after_stop_bridge_sets(&self, delay: Duration, lights: &[(&str, Value)]) {
        self.state.lock().unwrap().post_stream = Some(PostStream {
            delay,
            lights: lights
                .iter()
                .map(|(id, value)| (id.to_string(), value.clone()))
                .collect(),
        });
    }

    /// From now on, a read of every light at once (the restore's watch) is
    /// answered only after `delay`.
    pub(crate) fn answer_bulk_light_reads_after(&self, delay: Duration) {
        self.state.lock().unwrap().bulk_read_delay = delay;
    }

    /// Another app streams to `area`: the area reads active and these lights
    /// read `mode: streaming`.
    pub(crate) fn another_app_streams(&self, area: &str, lights: &[&str]) {
        let mut state = self.state.lock().unwrap();
        state.active.insert(area.to_string());
        for id in lights {
            if let Some(light) = state.lights.get_mut(*id) {
                light["mode"] = json!("streaming");
            }
        }
    }

    /// PUTs to this device answer 404 from now on.
    pub(crate) fn remove_device(&self, device_id: &str) {
        self.state
            .lock()
            .unwrap()
            .removed_devices
            .insert(device_id.to_string());
    }

    /// Every restore PUT, as `(light id, body)` in arrival order. A start's
    /// switch-on of an off light (`{"on":{"on":true}}` alone) is not one: see
    /// [`Self::switch_ons`]. A restore of an on light always carries its
    /// brightness here, since every light this bridge serves has `dimming`.
    pub(crate) fn light_puts(&self) -> Vec<(String, Value)> {
        self.all_light_puts()
            .into_iter()
            .filter(|(_, body)| *body != switch_on_body())
            .collect()
    }

    /// The lights a start switched on before its stream, in arrival order.
    pub(crate) fn switch_ons(&self) -> Vec<String> {
        self.all_light_puts()
            .into_iter()
            .filter(|(_, body)| *body == switch_on_body())
            .map(|(id, _)| id)
            .collect()
    }

    /// [`Self::light_puts`] as recorded, with their arrival times.
    pub(crate) fn restore_requests(&self) -> Vec<Recorded> {
        self.bridge
            .puts_to("/clip/v2/resource/light/")
            .into_iter()
            .filter(|r| r.json() != switch_on_body())
            .collect()
    }

    fn all_light_puts(&self) -> Vec<(String, Value)> {
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

fn switch_on_body() -> Value {
    json!({ "on": { "on": true } })
}

fn route(
    state: &Arc<Mutex<FakeHueState>>,
    areas: &HashMap<String, Vec<String>>,
    put_light: &LightPutRoute,
    method: &str,
    path: &str,
    body: &str,
) -> Reply {
    let not_found = || Reply::json(404, json!({ "errors": [{ "description": "not found" }] }));
    let rest = path.strip_prefix("/clip/v2/resource/").unwrap_or_default();
    let (rtype, id) = rest.split_once('/').unwrap_or((rest, ""));
    let data = |item: Value| Reply::json(200, json!({ "errors": [], "data": [item] }));
    match (method, rtype) {
        ("GET", "entertainment_configuration") => match areas.get(id) {
            Some(ids) => {
                let active = state.lock().unwrap().active.contains(id);
                data(json!({
                    "id": id,
                    "status": if active { "active" } else { "inactive" },
                    "active_streamer": if active {
                        json!({ "rid": "another-app", "rtype": "auth_v1" })
                    } else {
                        Value::Null
                    },
                    "channels": ids.iter().enumerate().map(|(index, light)| json!({
                        "channel_id": index,
                        "position": { "x": 0.0, "y": 0.8, "z": 0.0 },
                        "members": [{
                            "service": { "rid": format!("ent-{light}"), "rtype": "entertainment" },
                            "index": 0
                        }]
                    })).collect::<Vec<_>>()
                }))
            }
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
        ("GET", "light") if id.is_empty() => {
            let held = state.lock().unwrap();
            let delay = held.bulk_read_delay;
            let mut all: Vec<(String, Value)> = held
                .lights
                .iter()
                .map(|(id, light)| (id.clone(), light.clone()))
                .collect();
            drop(held);
            all.sort_by(|a, b| a.0.cmp(&b.0));
            let all: Vec<Value> = all
                .into_iter()
                .map(|(id, mut light)| {
                    // Owned the way `GET device` links it back.
                    light["owner"] = json!({ "rid": format!("dev-{id}"), "rtype": "device" });
                    light["id"] = json!(id);
                    light
                })
                .collect();
            Reply::json(200, json!({ "errors": [], "data": all })).after(delay)
        }
        ("GET", "light") => match state.lock().unwrap().lights.get(id) {
            Some(light) => data(light.clone()),
            None => not_found(),
        },
        ("PUT", "entertainment_configuration") => {
            let action = serde_json::from_str::<Value>(body)
                .ok()
                .and_then(|body| Some(body.get("action")?.as_str()?.to_string()));
            let mut held = state.lock().unwrap();
            match action.as_deref() {
                Some("start") => {
                    held.active.insert(id.to_string());
                }
                Some("stop") => {
                    held.active.remove(id);
                    if let Some(post) = held.post_stream.clone() {
                        let later = Arc::clone(state);
                        std::thread::spawn(move || {
                            std::thread::sleep(post.delay);
                            let mut held = later.lock().unwrap();
                            for (light, value) in post.lights {
                                held.lights.insert(light, value);
                            }
                        });
                    }
                }
                _ => {}
            }
            Reply::ok()
        }
        ("PUT", "device") => {
            if state.lock().unwrap().removed_devices.contains(id) {
                not_found()
            } else {
                Reply::ok()
            }
        }
        ("PUT", "light") => {
            let reply = put_light(id);
            if (200..300).contains(&reply.status) {
                let written: Value = serde_json::from_str(body).unwrap_or(Value::Null);
                if let Some(light) = state.lock().unwrap().lights.get_mut(id) {
                    apply_light_put(light, &written);
                }
            }
            reply
        }
        _ => not_found(),
    }
}

/// What a light PUT changes in the light's reported state.
fn apply_light_put(light: &mut Value, written: &Value) {
    if let Some(on) = written.get("on") {
        light["on"] = on.clone();
    }
    if let Some(brightness) = written.pointer("/dimming/brightness") {
        light["dimming"]["brightness"] = brightness.clone();
    }
    if let Some(mirek) = written.pointer("/color_temperature/mirek") {
        light["color_temperature"] = json!({ "mirek": mirek, "mirek_valid": true });
    }
    if let Some(xy) = written.pointer("/color/xy") {
        light["color"]["xy"] = xy.clone();
        light["color_temperature"] = json!({ "mirek": null, "mirek_valid": false });
    }
}
