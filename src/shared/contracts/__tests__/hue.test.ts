import { describe, expect, it } from "vitest";

import {
  HUE_COMMANDS,
  HUE_CREDENTIAL_BACKENDS,
  type HueCredentialBackend,
  type HuePairBridgeResponse,
} from "../hue";

describe("Hue credential backend wire contract", () => {
  // Shared with CredentialBackend::as_str; changing one side alone makes
  // "keychain" unrecognised, which downgrades to plaintext invisibly.
  it("pins the literal values Rust emits", () => {
    expect(HUE_CREDENTIAL_BACKENDS.KEYCHAIN).toBe("keychain");
    expect(HUE_CREDENTIAL_BACKENDS.PLAINTEXT_LEGACY).toBe("plaintext-legacy");
  });

  it("exposes the migration command id", () => {
    expect(HUE_COMMANDS.MIGRATE_CREDENTIALS).toBe("migrate_hue_credentials");
  });

  it("accepts an absent backend on the pairing response", () => {
    const backend: HueCredentialBackend | undefined = undefined;
    const response: HuePairBridgeResponse = {
      status: { code: "HUE_PAIRING_OK", message: "Paired." },
      credentials: { username: "app-key", clientKey: "psk" },
      credentialStorageBackend: backend,
    };

    expect(response.credentialStorageBackend).toBeUndefined();
  });

  it("accepts every declared backend on the pairing response", () => {
    const backends: HueCredentialBackend[] = [
      HUE_CREDENTIAL_BACKENDS.KEYCHAIN,
      HUE_CREDENTIAL_BACKENDS.PLAINTEXT_LEGACY,
    ];

    for (const backend of backends) {
      const response: HuePairBridgeResponse = {
        status: { code: "HUE_PAIRING_OK", message: "Paired." },
        credentials: null,
        credentialStorageBackend: backend,
      };
      expect(response.credentialStorageBackend).toBe(backend);
    }
  });
});
