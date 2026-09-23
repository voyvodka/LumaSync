//! A local HTTPS stand-in for a Hue bridge, for tests that drive the real
//! runtime paths. Every bridge call is `https://{bridge_ip}/…`, so passing
//! `127.0.0.1:<port>` as the bridge address routes them here unchanged; the
//! clients already accept the bridge's self-signed certificate, and this one's.
//!
//! Readiness cannot be driven this way — `is_valid_ipv4` refuses a loopback
//! address with a port, and that guard stays.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use openssl::asn1::Asn1Time;
use openssl::bn::BigNum;
use openssl::ec::{EcGroup, EcKey};
use openssl::hash::MessageDigest;
use openssl::nid::Nid;
use openssl::pkey::PKey;
use openssl::ssl::{SslAcceptor, SslMethod};
use openssl::x509::{X509Builder, X509NameBuilder};
use serde_json::{json, Value};

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
}

impl Reply {
    pub(crate) fn json(status: u16, body: serde_json::Value) -> Self {
        Self {
            status,
            content_type: "application/json",
            body: body.to_string(),
            delay: Duration::ZERO,
        }
    }

    pub(crate) fn ok() -> Self {
        Self::json(200, serde_json::json!({ "data": [], "errors": [] }))
    }

    pub(crate) fn after(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }
}

type Router = dyn Fn(&str, &str, &str) -> Reply + Send + Sync;

pub(crate) struct TestBridge {
    /// Pass this as `bridge_ip`.
    pub(crate) authority: String,
    seen: Arc<Mutex<Vec<Recorded>>>,
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
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let authority = listener.local_addr().unwrap().to_string();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let route: Arc<Router> = Arc::new(route);
        let (thread_seen, thread_stop) = (Arc::clone(&seen), Arc::clone(&stop));
        let handle = std::thread::spawn(move || {
            while !thread_stop.load(Ordering::SeqCst) {
                let Ok((stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                };
                let (seen, route) = (Arc::clone(&thread_seen), Arc::clone(&route));
                std::thread::spawn(move || serve(stream, &seen, route.as_ref()));
            }
        });
        Self {
            authority,
            seen,
            stop,
            handle: Some(handle),
        }
    }

    pub(crate) fn requests(&self) -> Vec<Recorded> {
        self.seen.lock().unwrap().clone()
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

fn acceptor() -> &'static SslAcceptor {
    static ACCEPTOR: OnceLock<SslAcceptor> = OnceLock::new();
    ACCEPTOR.get_or_init(|| {
        let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).unwrap();
        let key = PKey::from_ec_key(EcKey::generate(&group).unwrap()).unwrap();
        let mut name = X509NameBuilder::new().unwrap();
        name.append_entry_by_nid(Nid::COMMONNAME, "test-bridge")
            .unwrap();
        let name = name.build();
        let mut cert = X509Builder::new().unwrap();
        cert.set_version(2).unwrap();
        let serial = BigNum::from_u32(1).unwrap().to_asn1_integer().unwrap();
        cert.set_serial_number(&serial).unwrap();
        cert.set_subject_name(&name).unwrap();
        cert.set_issuer_name(&name).unwrap();
        cert.set_pubkey(&key).unwrap();
        cert.set_not_before(&Asn1Time::days_from_now(0).unwrap())
            .unwrap();
        cert.set_not_after(&Asn1Time::days_from_now(1).unwrap())
            .unwrap();
        cert.sign(&key, MessageDigest::sha256()).unwrap();
        let cert = cert.build();

        let mut builder = SslAcceptor::mozilla_intermediate_v5(SslMethod::tls()).unwrap();
        builder.set_private_key(&key).unwrap();
        builder.set_certificate(&cert).unwrap();
        builder.check_private_key().unwrap();
        builder.build()
    })
}

fn serve(stream: TcpStream, seen: &Mutex<Vec<Recorded>>, route: &Router) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let Ok(tls) = acceptor().accept(stream) else {
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
    let _ = write!(
        tls,
        "HTTP/1.1 {} X\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
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
        let bridge = TestBridge::start(move |method, path, _body| {
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
                ("PUT", "light") => put_light(id),
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
