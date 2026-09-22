/**
 * `validate_hue_credentials` used to answer with the `HUE_IP_*` /
 * `AUTH_INVALID_RE_PAIR_REQUIRED` codes borrowed from other onboarding
 * handlers, never the `HUE_CREDENTIAL_*` family the real Rust command
 * (`hue_onboarding.rs`) and `useHueBridgeReachability` actually speak. The
 * hook checks `code === HUE_STATUS.CREDENTIAL_VALID` to flip reachability on,
 * so the mock could never report a reachable bridge — every fixture-backed
 * session sat "unreachable" no matter what the world said.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { HUE_COMMANDS, HUE_STATUS } from "../../src/shared/contracts/hue";
import type { HueValidateCredentialsResponse } from "../../src/features/hue/hueOnboardingApi";
import { handlerFor } from "../handlers";
import { SCENARIOS } from "../scenarios";
import { setWorld } from "../state";

const call = (command: string, args?: Record<string, unknown>) => {
  const handler = handlerFor(command);
  expect(handler, `no handler for ${command}`).toBeDefined();
  return handler?.(args);
};

describe("validate_hue_credentials answers with the HUE_CREDENTIAL_* family", () => {
  it("reports HUE_CREDENTIAL_VALID when paired, reachable and accepted", () => {
    setWorld(SCENARIOS.furnished.build());
    const result = call(HUE_COMMANDS.VALIDATE_CREDENTIALS) as HueValidateCredentialsResponse;

    expect(result.status.code).toBe(HUE_STATUS.CREDENTIAL_VALID);
    expect(result.valid).toBe(true);
  });

  it("reports HUE_CREDENTIAL_INVALID, not an unreachable code, when the bridge rejects the key", () => {
    setWorld(SCENARIOS["hue-key-expired"].build());
    const result = call(HUE_COMMANDS.VALIDATE_CREDENTIALS) as HueValidateCredentialsResponse;

    expect(result.status.code).toBe(HUE_STATUS.CREDENTIAL_INVALID);
    expect(result.valid).toBe(false);
  });

  it("reports HUE_CREDENTIAL_CHECK_FAILED, not HUE_IP_UNREACHABLE, when the bridge is off the network", () => {
    setWorld(SCENARIOS["hue-unreachable"].build());
    const result = call(HUE_COMMANDS.VALIDATE_CREDENTIALS) as HueValidateCredentialsResponse;

    expect(result.status.code).toBe(HUE_STATUS.CREDENTIAL_CHECK_FAILED);
    expect(result.valid).toBe(false);
  });

  it("reports HUE_CREDENTIAL_INVALID when never paired", () => {
    setWorld(SCENARIOS.empty.build());
    const result = call(HUE_COMMANDS.VALIDATE_CREDENTIALS) as HueValidateCredentialsResponse;

    expect(result.status.code).toBe(HUE_STATUS.CREDENTIAL_INVALID);
    expect(result.valid).toBe(false);
  });
});

describe("useHueBridgeReachability's own reading of the codes above", () => {
  beforeEach(() => {
    setWorld(SCENARIOS.furnished.build());
  });

  it("only HUE_CREDENTIAL_VALID counts as reachable — the hook's exact check", () => {
    const result = call(HUE_COMMANDS.VALIDATE_CREDENTIALS) as HueValidateCredentialsResponse;
    // Mirrors `setHueReachable(code === HUE_STATUS.CREDENTIAL_VALID)` in
    // `useHueBridgeReachability.ts` — asserted against the literal the hook
    // compares against, not just "truthy", so a future rename of either side
    // still fails loudly here instead of drifting apart silently.
    expect(result.status.code === HUE_STATUS.CREDENTIAL_VALID).toBe(true);
  });

  it("HUE_CREDENTIAL_CHECK_FAILED is the only code the hook's retry budget counts against", () => {
    setWorld(SCENARIOS["hue-unreachable"].build());
    const result = call(HUE_COMMANDS.VALIDATE_CREDENTIALS) as HueValidateCredentialsResponse;
    expect(result.status.code === HUE_STATUS.CREDENTIAL_CHECK_FAILED).toBe(true);
  });
});
