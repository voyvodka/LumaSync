import { describe, expect, it } from "vitest";

import {
  DEFAULT_HUE_OFF_BEHAVIOR,
  HUE_COMMANDS,
  HUE_CREDENTIAL_BACKENDS,
  HUE_OFF_BEHAVIOR,
  resolveHueOffBehavior,
  type HueCredentialBackend,
  type HuePairBridgeResponse,
} from "../hue";

describe("Hue credential backend wire contract", () => {
  // Shared with CredentialBackend::as_str; changing one side alone makes
  // "keychain" unrecognised, which downgrades to plaintext invisibly.
  it("pins the literal values Rust emits", () => {
    expect(HUE_CREDENTIAL_BACKENDS.KEYCHAIN).toBe("keychain");
    expect(HUE_CREDENTIAL_BACKENDS.PLAINTEXT_LEGACY).toBe("plaintext-legacy");
    expect(HUE_CREDENTIAL_BACKENDS.DEV_FILE).toBe("dev-file");
  });

  it("exposes the migration command id", () => {
    expect(HUE_COMMANDS.MIGRATE_CREDENTIALS).toBe("migrate_hue_credentials");
  });

  it("accepts an absent backend on the pairing response", () => {
    const backend: HueCredentialBackend | undefined = undefined;
    const response: HuePairBridgeResponse = {
      status: { code: "HUE_PAIRING_OK", message: "Paired.", details: null },
      credentials: { username: "app-key", clientKey: "psk" },
      credentialStorageBackend: backend,
    };

    expect(response.credentialStorageBackend).toBeUndefined();
  });

  it("accepts every declared backend on the pairing response", () => {
    const backends: HueCredentialBackend[] = [
      HUE_CREDENTIAL_BACKENDS.KEYCHAIN,
      HUE_CREDENTIAL_BACKENDS.PLAINTEXT_LEGACY,
      HUE_CREDENTIAL_BACKENDS.DEV_FILE,
    ];

    for (const backend of backends) {
      const response: HuePairBridgeResponse = {
        status: { code: "HUE_PAIRING_OK", message: "Paired.", details: null },
        credentials: null,
        credentialStorageBackend: backend,
      };
      expect(response.credentialStorageBackend).toBe(backend);
    }
  });
});

describe("What Off does to the Hue lights", () => {
  // Rust deserialises `hueOffBehavior` with these exact spellings
  // (`HueLightsAfterStop`, camelCase); a drift reads as "turn off".
  it("pins the literal values Rust reads", () => {
    expect(HUE_OFF_BEHAVIOR.TURN_OFF).toBe("turnOff");
    expect(HUE_OFF_BEHAVIOR.RESTORE).toBe("restore");
  });

  // Existing installs have no saved value and get the new behaviour.
  it("reads anything but an explicit restore as turning the lights off", () => {
    expect(DEFAULT_HUE_OFF_BEHAVIOR).toBe("turnOff");
    expect(resolveHueOffBehavior(undefined)).toBe("turnOff");
    expect(resolveHueOffBehavior(null)).toBe("turnOff");
    expect(resolveHueOffBehavior("dim")).toBe("turnOff");
    expect(resolveHueOffBehavior("turnOff")).toBe("turnOff");
    expect(resolveHueOffBehavior("restore")).toBe("restore");
  });
});
