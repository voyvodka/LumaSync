//! Who is on the other end of a bridge HTTPS connection.
//!
//! A bridge certificate is accepted when it names a bridge (its CN is the
//! 16-hex-digit bridge id) and either chains to one of the two Signify roots
//! below or matches the leaf pinned for that bridge on first contact. The why —
//! and what each rejection means for the user — is in docs/architecture/hue.md
//! ("The bridge's certificate is checked, not trusted").

use std::fmt;
use std::sync::{Arc, OnceLock};

use log::{info, warn};
use openssl::hash::MessageDigest;
use openssl::nid::Nid;
use openssl::stack::Stack;
use openssl::x509::store::{X509Store, X509StoreBuilder};
use openssl::x509::verify::X509VerifyParam;
use openssl::x509::{X509StoreContext, X509};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, SubjectPublicKeyInfoDer, UnixTime};
use rustls::{CertificateError, DigitallySignedStruct, SignatureScheme};

use super::pin_store::{PinRecord, PinStore};

/// The two roots Signify publishes for bridge certificates: `root-bridge`
/// (Philips Hue, 2017–2038) and `Hue Root CA 01` (Signify Hue, 2025–2050).
/// Source and fingerprints are in docs/architecture/hue.md.
pub(crate) const SIGNIFY_BRIDGE_ROOTS_PEM: &str = "\
-----BEGIN CERTIFICATE-----
MIICMjCCAdigAwIBAgIUO7FSLbaxikuXAljzVaurLXWmFw4wCgYIKoZIzj0EAwIw
OTELMAkGA1UEBhMCTkwxFDASBgNVBAoMC1BoaWxpcHMgSHVlMRQwEgYDVQQDDAty
b290LWJyaWRnZTAiGA8yMDE3MDEwMTAwMDAwMFoYDzIwMzgwMTE5MDMxNDA3WjA5
MQswCQYDVQQGEwJOTDEUMBIGA1UECgwLUGhpbGlwcyBIdWUxFDASBgNVBAMMC3Jv
b3QtYnJpZGdlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEjNw2tx2AplOf9x86
aTdvEcL1FU65QDxziKvBpW9XXSIcibAeQiKxegpq8Exbr9v6LBnYbna2VcaK0G22
jOKkTqOBuTCBtjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNV
HQ4EFgQUZ2ONTFrDT6o8ItRnKfqWKnHFGmQwdAYDVR0jBG0wa4AUZ2ONTFrDT6o8
ItRnKfqWKnHFGmShPaQ7MDkxCzAJBgNVBAYTAk5MMRQwEgYDVQQKDAtQaGlsaXBz
IEh1ZTEUMBIGA1UEAwwLcm9vdC1icmlkZ2WCFDuxUi22sYpLlwJY81Wrqy11phcO
MAoGCCqGSM49BAMCA0gAMEUCIEBYYEOsa07TH7E5MJnGw557lVkORgit2Rm1h3B2
sFgDAiEA1Fj/C3AN5psFMjo0//mrQebo0eKd3aWRx+pQY08mk48=
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIBzDCCAXOgAwIBAgICEAAwCgYIKoZIzj0EAwIwPDELMAkGA1UEBhMCTkwxFDAS
BgNVBAoMC1NpZ25pZnkgSHVlMRcwFQYDVQQDDA5IdWUgUm9vdCBDQSAwMTAgFw0y
NTAyMjUwMDAwMDBaGA8yMDUwMTIzMTIzNTk1OVowPDELMAkGA1UEBhMCTkwxFDAS
BgNVBAoMC1NpZ25pZnkgSHVlMRcwFQYDVQQDDA5IdWUgUm9vdCBDQSAwMTBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABFfOO0jfSAUXGQ9kjEDzyBrcMQ3ItyA5krE+
cyvb1Y3xFti7KlAad8UOnAx0FBLn7HZrlmIwm1QnX0fK3LPM13mjYzBhMB0GA1Ud
DgQWBBTF1pSpsCASX/z0VHLigxU2CAaqoTAfBgNVHSMEGDAWgBTF1pSpsCASX/z0
VHLigxU2CAaqoTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggq
hkjOPQQDAgNHADBEAiAk7duT+IHbOGO4UUuGLAEpyYejGZK9Z7V9oSfnvuQ5BQIg
IYSgwwxHXm73/JgcU9lAM6c8Bmu3UE3kBIUwBs1qXFw=
-----END CERTIFICATE-----
";

/// The wire code a refused certificate surfaces as, and the token its
/// `Display` starts with so it survives into `details` strings.
pub(crate) const IDENTITY_MISMATCH_CODE: &str = "HUE_BRIDGE_IDENTITY_MISMATCH";

/// A bridge id is 16 hex digits. The Bridge Pro (BSB003) writes it upper-case
/// in its certificate CN, the square bridge lower-case, so it is compared and
/// stored lower-case.
pub(crate) fn normalize_bridge_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (trimmed.len() == 16 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| trimmed.to_ascii_lowercase())
}

/// Why a presented certificate was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum IdentityRejection {
    /// Not a certificate openssl can read.
    Unreadable(String),
    /// Its CN is not a bridge id, so it cannot be a bridge's.
    NotABridge,
    /// A different bridge than the one the credentials belong to.
    WrongBridge { expected: String, presented: String },
    /// Not the certificate pinned for this bridge on first contact.
    CertificateChanged { bridge_id: String },
    /// This bridge has presented a Signify-signed certificate before and now
    /// presents one that is not.
    SignatureDowngrade { bridge_id: String },
}

impl IdentityRejection {
    /// One short phrase per case; the bridge id is not secret.
    fn reason(&self) -> String {
        match self {
            Self::Unreadable(detail) => format!("unreadable certificate ({detail})"),
            Self::NotABridge => "the certificate does not name a Hue bridge".to_string(),
            Self::WrongBridge {
                expected,
                presented,
            } => format!("expected bridge {expected}, the certificate names {presented}"),
            Self::CertificateChanged { bridge_id } => {
                format!("bridge {bridge_id} presented a different certificate than the one pinned")
            }
            Self::SignatureDowngrade { bridge_id } => format!(
                "bridge {bridge_id} used to present a Signify-signed certificate and now does not"
            ),
        }
    }
}

impl fmt::Display for IdentityRejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{IDENTITY_MISMATCH_CODE}: {}", self.reason())
    }
}

impl std::error::Error for IdentityRejection {}

/// What a certificate claims, before any trust decision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PresentedCertificate {
    /// Lower-case bridge id from the CN.
    pub(crate) bridge_id: String,
    /// Chains to a Signify root at the handshake time.
    pub(crate) signify_signed: bool,
    /// SHA-256 over the leaf DER, lower-case hex.
    pub(crate) fingerprint: String,
}

fn parsed_roots() -> &'static [X509] {
    static ROOTS: OnceLock<Vec<X509>> = OnceLock::new();
    ROOTS.get_or_init(|| {
        X509::stack_from_pem(SIGNIFY_BRIDGE_ROOTS_PEM.as_bytes())
            .expect("the pinned Signify roots are valid PEM")
    })
}

/// The store is built per check because the verify time is a store parameter.
fn root_store(at_unix: Option<u64>) -> Result<X509Store, openssl::error::ErrorStack> {
    let mut builder = X509StoreBuilder::new()?;
    for root in parsed_roots() {
        builder.add_cert(root.clone())?;
    }
    if let Some(at) = at_unix {
        let mut param = X509VerifyParam::new()?;
        param.set_time(at as _);
        builder.set_param(&param)?;
    }
    Ok(builder.build())
}

fn chains_to_signify_root(leaf: &X509, intermediates: &[X509], at_unix: Option<u64>) -> bool {
    let verified = (|| -> Result<bool, openssl::error::ErrorStack> {
        let store = root_store(at_unix)?;
        let mut chain = Stack::new()?;
        for cert in intermediates {
            chain.push(cert.clone())?;
        }
        let mut context = X509StoreContext::new()?;
        context.init(&store, leaf, &chain, |ctx| ctx.verify_cert())
    })();
    verified.unwrap_or(false)
}

fn common_name(cert: &X509) -> Option<String> {
    cert.subject_name()
        .entries_by_nid(Nid::COMMONNAME)
        .next()
        .and_then(|entry| entry.data().to_string().ok())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Read what a certificate chain claims. `at_unix` is the handshake time;
/// `None` checks validity against the system clock. Everything returned is
/// public — the bridge hands this chain to anyone who connects — so the bridge
/// id and fingerprint are safe to log.
pub(crate) fn inspect_presented_chain(
    leaf_der: &[u8],
    intermediates_der: &[&[u8]],
    at_unix: Option<u64>,
) -> Result<PresentedCertificate, IdentityRejection> {
    let leaf = X509::from_der(leaf_der)
        .map_err(|error| IdentityRejection::Unreadable(error.to_string()))?;
    let bridge_id = common_name(&leaf)
        .as_deref()
        .and_then(normalize_bridge_id)
        .ok_or(IdentityRejection::NotABridge)?;
    let intermediates = intermediates_der
        .iter()
        .filter_map(|der| X509::from_der(der).ok())
        .collect::<Vec<_>>();
    let fingerprint = leaf
        .digest(MessageDigest::sha256())
        .map(|digest| hex(&digest))
        .map_err(|error| IdentityRejection::Unreadable(error.to_string()))?;
    Ok(PresentedCertificate {
        signify_signed: chains_to_signify_root(&leaf, &intermediates, at_unix),
        bridge_id,
        fingerprint,
    })
}

/// The bridge id a certificate names, for a response whose handshake already
/// passed the verifier.
pub(crate) fn bridge_id_named_by_leaf(leaf_der: &[u8]) -> Option<String> {
    let leaf = X509::from_der(leaf_der).ok()?;
    normalize_bridge_id(&common_name(&leaf)?)
}

/// How strictly a client treats a certificate that is not the pinned one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum TrustMode {
    Strict,
    /// Link-button pairing only: a self-signed bridge whose pinned leaf changed
    /// (a factory reset regenerates it) is re-learned instead of locked out.
    /// A downgrade from a Signify-signed certificate is still refused.
    Pairing,
}

/// What a client expects of the bridge it connects to.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct BridgeTrust {
    /// The bridge the credentials in use belong to; `None` accepts any bridge.
    pub(crate) expected: Option<String>,
    pub(crate) mode: TrustMode,
}

impl BridgeTrust {
    pub(crate) fn any() -> Self {
        Self {
            expected: None,
            mode: TrustMode::Strict,
        }
    }

    pub(crate) fn bridge(bridge_id: &str) -> Self {
        Self {
            expected: normalize_bridge_id(bridge_id),
            mode: TrustMode::Strict,
        }
    }

    pub(crate) fn pairing() -> Self {
        Self {
            expected: None,
            mode: TrustMode::Pairing,
        }
    }
}

fn store_pin(store: &dyn PinStore, bridge_id: &str, record: &PinRecord) {
    if let Err(error) = store.set(bridge_id, record) {
        warn!("[hue-tls] could not store the certificate pin for bridge {bridge_id}: {error}");
    }
}

/// Decide whether `presented` may carry this connection, recording what is
/// learned on the way. A pin that cannot be read or written degrades to
/// trust-on-every-use for self-signed bridges; a Signify-signed one is checked
/// against the roots regardless.
pub(crate) fn admit(
    presented: &PresentedCertificate,
    trust: &BridgeTrust,
    store: &dyn PinStore,
) -> Result<(), IdentityRejection> {
    let bridge_id = &presented.bridge_id;
    if let Some(expected) = &trust.expected {
        if expected != bridge_id {
            return Err(IdentityRejection::WrongBridge {
                expected: expected.clone(),
                presented: bridge_id.clone(),
            });
        }
    }

    let pinned = store.get(bridge_id);

    if presented.signify_signed {
        if !matches!(pinned, Some(PinRecord::SignifySigned(_))) {
            info!("[hue-tls] bridge {bridge_id} presents a Signify-signed certificate; pinned");
            let record = PinRecord::SignifySigned(presented.fingerprint.clone());
            store_pin(store, bridge_id, &record);
        }
        return Ok(());
    }

    let leaf = PinRecord::Leaf(presented.fingerprint.clone());
    match pinned {
        Some(PinRecord::SignifySigned(_)) => Err(IdentityRejection::SignatureDowngrade {
            bridge_id: bridge_id.clone(),
        }),
        Some(record) if record == leaf => Ok(()),
        Some(_) if trust.mode == TrustMode::Pairing => {
            warn!(
                "[hue-tls] bridge {bridge_id} presents a new self-signed certificate during \
                 pairing; re-pinned to sha256:{}",
                presented.fingerprint
            );
            store_pin(store, bridge_id, &leaf);
            Ok(())
        }
        Some(_) => Err(IdentityRejection::CertificateChanged {
            bridge_id: bridge_id.clone(),
        }),
        None => {
            info!(
                "[hue-tls] bridge {bridge_id} presents a self-signed certificate; pinned on \
                 first use to sha256:{}",
                presented.fingerprint
            );
            store_pin(store, bridge_id, &leaf);
            Ok(())
        }
    }
}

/// The `rustls` verifier every bridge client uses. The server name is an IP
/// literal and the certificate names a bridge id, so hostname verification has
/// nothing to compare; identity is the CN, checked by [`admit`].
pub(crate) struct BridgeCertVerifier {
    trust: BridgeTrust,
    store: Arc<dyn PinStore>,
    provider: Arc<CryptoProvider>,
}

impl BridgeCertVerifier {
    pub(crate) fn new(
        trust: BridgeTrust,
        store: Arc<dyn PinStore>,
        provider: Arc<CryptoProvider>,
    ) -> Self {
        Self {
            trust,
            store,
            provider,
        }
    }

    /// Signature check against the leaf's public key alone, so a certificate
    /// `webpki` would refuse to parse as an end entity (an old self-signed
    /// bridge's) still completes the handshake it was pinned for.
    fn verify_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
        first_candidate_only: bool,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        let spki = X509::from_der(cert.as_ref())
            .and_then(|leaf| leaf.public_key())
            .and_then(|key| key.public_key_to_der())
            .map_err(|_| rustls::Error::InvalidCertificate(CertificateError::BadEncoding))?;
        let spki = SubjectPublicKeyInfoDer::from(spki);
        let key = webpki::RawPublicKeyEntity::try_from(&spki)
            .map_err(|_| rustls::Error::InvalidCertificate(CertificateError::BadEncoding))?;
        let candidates = self
            .provider
            .signature_verification_algorithms
            .mapping
            .iter()
            .find(|(scheme, _)| *scheme == dss.scheme)
            .map(|(_, algorithms)| *algorithms)
            .ok_or(rustls::Error::PeerMisbehaved(
                rustls::PeerMisbehaved::SignedHandshakeWithUnadvertisedSigScheme,
            ))?;
        let candidates = if first_candidate_only {
            &candidates[..candidates.len().min(1)]
        } else {
            candidates
        };
        for algorithm in candidates {
            match key.verify_signature(*algorithm, message, dss.signature()) {
                Ok(()) => return Ok(HandshakeSignatureValid::assertion()),
                Err(webpki::Error::UnsupportedSignatureAlgorithmForPublicKeyContext(_)) => continue,
                Err(_) => break,
            }
        }
        Err(rustls::Error::InvalidCertificate(
            CertificateError::BadSignature,
        ))
    }
}

impl fmt::Debug for BridgeCertVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BridgeCertVerifier")
            .field("trust", &self.trust)
            .finish_non_exhaustive()
    }
}

impl ServerCertVerifier for BridgeCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let intermediates = intermediates
            .iter()
            .map(|der| der.as_ref())
            .collect::<Vec<_>>();
        let result =
            inspect_presented_chain(end_entity.as_ref(), &intermediates, Some(now.as_secs()))
                .and_then(|presented| admit(&presented, &self.trust, self.store.as_ref()));
        match result {
            Ok(()) => Ok(ServerCertVerified::assertion()),
            Err(rejection) => {
                warn!("[hue-tls] refused a bridge certificate: {rejection}");
                Err(rustls::Error::InvalidCertificate(CertificateError::Other(
                    rustls::OtherError(Arc::new(rejection)),
                )))
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.verify_signature(message, cert, dss, false)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        let tls13_scheme = matches!(
            dss.scheme,
            SignatureScheme::ECDSA_NISTP256_SHA256
                | SignatureScheme::ECDSA_NISTP384_SHA384
                | SignatureScheme::ECDSA_NISTP521_SHA512
                | SignatureScheme::RSA_PSS_SHA256
                | SignatureScheme::RSA_PSS_SHA384
                | SignatureScheme::RSA_PSS_SHA512
                | SignatureScheme::ED25519
                | SignatureScheme::ED448
        );
        if !tls13_scheme {
            return Err(rustls::Error::PeerMisbehaved(
                rustls::PeerMisbehaved::SignedHandshakeWithUnadvertisedSigScheme,
            ));
        }
        // TLS 1.3 binds an ECDSA scheme to its curve: only the first mapping
        // entry is the one named by the scheme.
        self.verify_signature(message, cert, dss, true)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// The `rustls` error behind a failed request, if the TLS layer failed it.
///
/// The chain is walked through `io::Error::get_ref`, not `source`: hyper and
/// tokio-rustls nest `io::Error`s, and an `io::Error`'s `source()` skips the
/// error it wraps and returns *that* error's source.
pub(crate) fn rustls_error_in<'a>(
    error: &'a (dyn std::error::Error + 'static),
) -> Option<&'a rustls::Error> {
    let mut current = Some(error);
    while let Some(err) = current {
        if let Some(tls) = err.downcast_ref::<rustls::Error>() {
            return Some(tls);
        }
        current = match err.downcast_ref::<std::io::Error>() {
            Some(io) => io
                .get_ref()
                .map(|inner| inner as &(dyn std::error::Error + 'static)),
            None => err.source(),
        };
    }
    None
}

/// The rejection behind a failed request, if a bridge certificate was refused.
pub(crate) fn identity_rejection_in(
    error: &(dyn std::error::Error + 'static),
) -> Option<IdentityRejection> {
    if let Some(rejection) = error.downcast_ref::<IdentityRejection>() {
        return Some(rejection.clone());
    }
    match rustls_error_in(error)? {
        rustls::Error::InvalidCertificate(CertificateError::Other(other)) => {
            other.0.downcast_ref::<IdentityRejection>().cloned()
        }
        _ => None,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::commands::hue::pin_store::MemoryPinStore;
    use openssl::asn1::Asn1Time;
    use openssl::bn::BigNum;
    use openssl::ec::{EcGroup, EcKey};
    use openssl::pkey::{PKey, Private};
    use openssl::x509::extension::BasicConstraints;
    use openssl::x509::{X509Builder, X509NameBuilder};

    pub(crate) const BRIDGE_A: &str = "001788fffe000a01";
    pub(crate) const BRIDGE_B: &str = "001788fffe000b02";

    /// A real Hue Bridge Pro (BSB003) certificate, published by its owner in
    /// openhab/openhab-addons#19337 so integrators could add support. Its CN
    /// is the bridge id in upper case and it chains to `root-bridge`.
    const BRIDGE_PRO_LEAF_PEM: &str = "\
-----BEGIN CERTIFICATE-----
MIICUDCCAfWgAwIBAgIJAMQplv/+xOLYMAoGCCqGSM49BAMCMDkxCzAJBgNVBAYT
Ak5MMRQwEgYDVQQKDAtQaGlsaXBzIEh1ZTEUMBIGA1UEAwwLcm9vdC1icmlkZ2Uw
IhgPMjAyNTAyMjcxMzIxMTFaGA8yMDM4MDExOTAzMTQwN1owTzELMAkGA1UEBhMC
TkwxFDASBgNVBAoMC1BoaWxpcHMgSHVlMRkwFwYDVQQDDBBDNDI5OTZGRkZFQzRF
MkQ4MQ8wDQYDVQQLDAZCU0IwMDMwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATr
eQ8P8I2okD2ypnXLNGniE14QoxYM1n7A/Ld3/G/VHbxAcOsRK+9fok4FsJ4jGJ8R
w9w8iHKtmySjk8frVBxvo4HLMIHIMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQD
AgeAMBMGA1UdJQQMMAoGCCsGAQUFBwMBMB0GA1UdDgQWBBTHTFUlMVjBfCRDW5Jn
rT1qvxaQhjB0BgNVHSMEbTBrgBRnY41MWsNPqjwi1Gcp+pYqccUaZKE9pDswOTEL
MAkGA1UEBhMCTkwxFDASBgNVBAoMC1BoaWxpcHMgSHVlMRQwEgYDVQQDDAtyb290
LWJyaWRnZYIUO7FSLbaxikuXAljzVaurLXWmFw4wCgYIKoZIzj0EAwIDSQAwRgIh
AP31tUs6kG4a9CifLyi7MaFYZBcxMZY0u+yNFK2eCqXzAiEAnD9leje6HlDcgWft
316G3aFaj+wrBf6TzOwxNkPY0rg=
-----END CERTIFICATE-----
";

    pub(crate) struct TestCert {
        pub(crate) cert: X509,
        pub(crate) key: PKey<Private>,
    }

    impl TestCert {
        pub(crate) fn der(&self) -> Vec<u8> {
            self.cert.to_der().unwrap()
        }
    }

    fn ec_key() -> PKey<Private> {
        let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).unwrap();
        PKey::from_ec_key(EcKey::generate(&group).unwrap()).unwrap()
    }

    fn build(cn: &str, issuer: Option<&TestCert>, is_ca: bool) -> TestCert {
        let key = ec_key();
        let mut name = X509NameBuilder::new().unwrap();
        name.append_entry_by_nid(Nid::COMMONNAME, cn).unwrap();
        let name = name.build();
        let mut cert = X509Builder::new().unwrap();
        cert.set_version(2).unwrap();
        let serial = BigNum::from_u32(rand_serial()).unwrap();
        cert.set_serial_number(&serial.to_asn1_integer().unwrap())
            .unwrap();
        cert.set_subject_name(&name).unwrap();
        match issuer {
            Some(issuer) => cert.set_issuer_name(issuer.cert.subject_name()).unwrap(),
            None => cert.set_issuer_name(&name).unwrap(),
        }
        cert.set_pubkey(&key).unwrap();
        cert.set_not_before(&Asn1Time::days_from_now(0).unwrap())
            .unwrap();
        cert.set_not_after(&Asn1Time::days_from_now(2).unwrap())
            .unwrap();
        if is_ca {
            cert.append_extension(BasicConstraints::new().critical().ca().build().unwrap())
                .unwrap();
        }
        let signer = issuer.map_or(&key, |issuer| &issuer.key);
        cert.sign(signer, MessageDigest::sha256()).unwrap();
        TestCert {
            cert: cert.build(),
            key,
        }
    }

    fn rand_serial() -> u32 {
        uuid::Uuid::new_v4().as_u128() as u32 | 1
    }

    /// A self-signed leaf naming `cn`, like an older bridge's.
    pub(crate) fn self_signed(cn: &str) -> TestCert {
        build(cn, None, false)
    }

    /// A CA the test controls, and a leaf it signs for `cn`.
    pub(crate) fn ca_signed(cn: &str) -> (TestCert, TestCert) {
        let ca = build("test root", None, true);
        let leaf = build(cn, Some(&ca), false);
        (ca, leaf)
    }

    fn presented(bridge_id: &str, signify_signed: bool, fingerprint: &str) -> PresentedCertificate {
        PresentedCertificate {
            bridge_id: bridge_id.to_string(),
            signify_signed,
            fingerprint: fingerprint.to_string(),
        }
    }

    fn pin_of(store: &MemoryPinStore, bridge_id: &str) -> Option<String> {
        store.get(bridge_id).map(|record| match record {
            PinRecord::SignifySigned(_) => "signify".to_string(),
            PinRecord::Leaf(fingerprint) => format!("sha256:{fingerprint}"),
        })
    }

    #[test]
    fn a_real_bridge_pro_certificate_chains_to_the_pinned_root() {
        let leaf = X509::from_pem(BRIDGE_PRO_LEAF_PEM.as_bytes()).unwrap();
        let presented = inspect_presented_chain(&leaf.to_der().unwrap(), &[], None).unwrap();
        assert_eq!(presented.bridge_id, "c42996fffec4e2d8");
        assert!(presented.signify_signed);
    }

    #[test]
    fn both_published_roots_are_pinned() {
        let names = parsed_roots()
            .iter()
            .map(|root| common_name(root).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["root-bridge", "Hue Root CA 01"]);
    }

    #[test]
    fn a_certificate_from_another_ca_is_not_signify_signed() {
        let (ca, leaf) = ca_signed(BRIDGE_A);
        let presented =
            inspect_presented_chain(&leaf.der(), &[&ca.der()], None).expect("readable bridge cert");
        assert_eq!(presented.bridge_id, BRIDGE_A);
        assert!(!presented.signify_signed);
    }

    #[test]
    fn a_certificate_that_names_no_bridge_is_refused() {
        let cert = self_signed("test-bridge");
        assert_eq!(
            inspect_presented_chain(&cert.der(), &[], None),
            Err(IdentityRejection::NotABridge)
        );
        assert_eq!(
            normalize_bridge_id("001788FFFE000A01").as_deref(),
            Some(BRIDGE_A)
        );
        assert_eq!(normalize_bridge_id("192.168.1.2"), None);
        assert_eq!(normalize_bridge_id("001788fffe000a0"), None);
    }

    #[test]
    fn a_signify_signed_bridge_is_admitted_and_remembered_as_such() {
        let store = MemoryPinStore::default();
        admit(
            &presented(BRIDGE_A, true, "aa"),
            &BridgeTrust::any(),
            &store,
        )
        .unwrap();
        assert_eq!(pin_of(&store, BRIDGE_A).as_deref(), Some("signify"));
    }

    #[test]
    fn the_wrong_bridge_is_refused_even_when_signify_signed() {
        let store = MemoryPinStore::default();
        let result = admit(
            &presented(BRIDGE_B, true, "aa"),
            &BridgeTrust::bridge(BRIDGE_A),
            &store,
        );
        assert_eq!(
            result,
            Err(IdentityRejection::WrongBridge {
                expected: BRIDGE_A.to_string(),
                presented: BRIDGE_B.to_string()
            })
        );
        assert_eq!(
            pin_of(&store, BRIDGE_B),
            None,
            "nothing learned from a refusal"
        );
    }

    #[test]
    fn a_self_signed_bridge_is_pinned_on_first_use_and_held_to_it() {
        let store = MemoryPinStore::default();
        admit(
            &presented(BRIDGE_A, false, "aa"),
            &BridgeTrust::any(),
            &store,
        )
        .unwrap();
        assert_eq!(pin_of(&store, BRIDGE_A).as_deref(), Some("sha256:aa"));

        admit(
            &presented(BRIDGE_A, false, "aa"),
            &BridgeTrust::any(),
            &store,
        )
        .unwrap();
        assert_eq!(
            admit(
                &presented(BRIDGE_A, false, "bb"),
                &BridgeTrust::any(),
                &store
            ),
            Err(IdentityRejection::CertificateChanged {
                bridge_id: BRIDGE_A.to_string()
            })
        );
        assert_eq!(pin_of(&store, BRIDGE_A).as_deref(), Some("sha256:aa"));
    }

    #[test]
    fn a_bridge_seen_signify_signed_cannot_fall_back_to_self_signed() {
        let store = MemoryPinStore::default();
        admit(
            &presented(BRIDGE_A, true, "aa"),
            &BridgeTrust::any(),
            &store,
        )
        .unwrap();
        for trust in [BridgeTrust::any(), BridgeTrust::pairing()] {
            assert_eq!(
                admit(&presented(BRIDGE_A, false, "bb"), &trust, &store),
                Err(IdentityRejection::SignatureDowngrade {
                    bridge_id: BRIDGE_A.to_string()
                })
            );
        }
    }

    #[test]
    fn a_self_signed_bridge_upgraded_to_signify_is_re_pinned() {
        let store = MemoryPinStore::default();
        admit(
            &presented(BRIDGE_A, false, "aa"),
            &BridgeTrust::any(),
            &store,
        )
        .unwrap();
        admit(
            &presented(BRIDGE_A, true, "cc"),
            &BridgeTrust::any(),
            &store,
        )
        .unwrap();
        assert_eq!(pin_of(&store, BRIDGE_A).as_deref(), Some("signify"));
    }

    #[test]
    fn only_pairing_re_learns_a_changed_self_signed_certificate() {
        let store = MemoryPinStore::default();
        admit(
            &presented(BRIDGE_A, false, "aa"),
            &BridgeTrust::any(),
            &store,
        )
        .unwrap();
        admit(
            &presented(BRIDGE_A, false, "bb"),
            &BridgeTrust::pairing(),
            &store,
        )
        .unwrap();
        assert_eq!(pin_of(&store, BRIDGE_A).as_deref(), Some("sha256:bb"));
    }

    #[test]
    fn a_rejection_is_found_through_the_io_error_rustls_is_wrapped_in() {
        let rejection = IdentityRejection::CertificateChanged {
            bridge_id: BRIDGE_A.to_string(),
        };
        let tls = rustls::Error::InvalidCertificate(CertificateError::Other(rustls::OtherError(
            Arc::new(rejection.clone()),
        )));
        let io = std::io::Error::other(tls);
        assert_eq!(identity_rejection_in(&io), Some(rejection.clone()));
        assert!(rejection.to_string().starts_with(IDENTITY_MISMATCH_CODE));
    }
}
