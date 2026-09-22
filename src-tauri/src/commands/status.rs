//! The one coded-status envelope, mirroring `CommandStatusOf<TCode>` in
//! `src/shared/contracts/status.ts`. The per-domain code unions live on the TS
//! side only; here `code` is a `String` and each producer emits its own set.

use serde::{Deserialize, Serialize};

/// `details` carries no `skip_serializing_if`: the wire sends `null`, never an
/// absent key, and the TS type (`string | null`) is written against that.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandStatus {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

impl CommandStatus {
    pub fn new(code: &str, message: &str, details: Option<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            details,
        }
    }

    /// A status with no `details` — the shape every success outcome takes.
    pub fn ok(code: &str, message: &str) -> Self {
        Self::new(code, message, None)
    }
}
