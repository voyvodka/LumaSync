/**
 * `validate_hue_credentials` used to answer with the `HUE_IP_*` /
 * `AUTH_INVALID_RE_PAIR_REQUIRED` codes borrowed from other onboarding
 * handlers, never the `HUE_CREDENTIAL_*` family the real Rust command
 * (`hue_onboarding.rs`) and the health monitor (`commands/hue/health.rs`)
 * actually speak. The monitor checks for `HUE_CREDENTIAL_VALID` to call the
 * bridge reachable, so the mock could never report a reachable bridge — every
 * fixture-backed session sat "unreachable" no matter what the world said.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  HUE_COMMANDS,
  HUE_READINESS_REASON,
  HUE_RUNTIME_STATES,
  HUE_RUNTIME_STATUS,
  HUE_STATUS,
} from "../../src/shared/contracts/hue";
import type {
  HueEntertainmentAreaListResponse,
  HuePairBridgeResponse,
  HueStreamReadinessResponse,
  HueValidateCredentialsResponse,
} from "../../src/features/hue/hueOnboardingApi";
import { isHueStopCodeOk } from "../../src/features/hue/model/hueStartConfig";
import type { HueRuntimeCommandResult, ModeCommandResult } from "../../src/features/mode/modeApi";
import { DEVICE_COMMANDS } from "../../src/shared/contracts/device";
import { HUE_HEALTH_COMMANDS, type HueHealthSnapshot } from "../../src/shared/contracts/hueHealth";
import { dispatch } from "../dispatch";
import { handlerFor } from "../handlers";
import { SCENARIOS } from "../scenarios";
import { mutate, setWorld } from "../state";

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

describe("the health monitor's own reading of the codes above", () => {
  beforeEach(() => {
    setWorld(SCENARIOS.furnished.build());
  });

  it("only HUE_CREDENTIAL_VALID counts as reachable — the monitor's exact check", () => {
    const result = call(HUE_COMMANDS.VALIDATE_CREDENTIALS) as HueValidateCredentialsResponse;
    // Mirrors `verdict_for` in `commands/hue/health.rs` — asserted against the
    // literal it compares against, not just "truthy", so a future rename of
    // either side still fails loudly here instead of drifting apart silently.
    expect(result.status.code === HUE_STATUS.CREDENTIAL_VALID).toBe(true);
  });

  it("HUE_CREDENTIAL_CHECK_FAILED is the only code the monitor's give-up budget counts against", () => {
    setWorld(SCENARIOS["hue-unreachable"].build());
    const result = call(HUE_COMMANDS.VALIDATE_CREDENTIALS) as HueValidateCredentialsResponse;
    expect(result.status.code === HUE_STATUS.CREDENTIAL_CHECK_FAILED).toBe(true);
  });
});

/**
 * `hueRuntimeFault` used to report `Reconnecting` for any unreachable bridge,
 * whether or not a stream had ever gone live. `register_transient_fault`
 * (`src-tauri/src/commands/hue/retry.rs`) — the only producer of
 * `Reconnecting` on the wire — is reachable only from the reconnect monitor
 * and `status_refresh_with_evidence`, both gated on
 * `Starting | Running | Reconnecting`. A start attempt against a runtime that
 * has never gone `Running` instead fails the strict gate in
 * `start_with_evidence` (`hue/retry.rs`), which reports
 * `Idle`/`CONFIG_NOT_READY_GATE_BLOCKED` — never `Reconnecting`.
 *
 * These drive the mock through `dispatch`, the same entry
 * `mock/tauriCoreShim.ts` hands the app's own `invoke` calls, rather than
 * `handlerFor` — `dispatch` is what actually resolves on a macrotask and runs
 * the forced-code/stale-generation machinery a handler called directly skips.
 */
describe("hueRuntimeFault distinguishes a start-time gate block from a live-stream reconnect", () => {
  it("an unreachable bridge before any stream reports the real gate-blocked shape, not Reconnecting", async () => {
    const world = SCENARIOS.empty.build();
    world.hue.reachable = false;
    setWorld(world);
    expect(world.hue.everActive).toBe(false);

    const result = (await dispatch(HUE_COMMANDS.START_STREAM)) as HueRuntimeCommandResult;

    expect(result.status.code).toBe(HUE_RUNTIME_STATUS.CONFIG_NOT_READY_GATE_BLOCKED);
    expect(result.status.state).toBe(HUE_RUNTIME_STATES.IDLE);
    expect(result.active).toBe(false);
  });

  it("an unreachable bridge after a stream was live still reports Reconnecting", async () => {
    // `hue-unreachable` builds off `furnished`, which leaves `everActive: true`
    // — the scenario models a stream that was running before the bridge went
    // dark, not a start attempt against a never-started runtime.
    const world = SCENARIOS["hue-unreachable"].build();
    setWorld(world);
    expect(world.hue.everActive).toBe(true);

    const result = (await dispatch(HUE_COMMANDS.GET_STREAM_STATUS)) as HueRuntimeCommandResult;

    expect(result.status.code).toBe(HUE_RUNTIME_STATUS.TRANSIENT_RETRY_SCHEDULED);
    expect(result.status.state).toBe(HUE_RUNTIME_STATES.RECONNECTING);
  });

  it("an invalid key stays Failed regardless of everActive", async () => {
    const world = SCENARIOS.empty.build();
    world.hue.credentialValid = false;
    setWorld(world);
    expect(world.hue.everActive).toBe(false);

    const result = (await dispatch(HUE_COMMANDS.START_STREAM)) as HueRuntimeCommandResult;

    expect(result.status.code).toBe(HUE_RUNTIME_STATUS.AUTH_INVALID_CREDENTIALS);
    expect(result.status.state).toBe(HUE_RUNTIME_STATES.FAILED);
  });
});

/**
 * `stop_hue_stream` is local in Rust: `stop_with_timeout` (`hue/retry.rs`)
 * leaves Idle / `HUE_STREAM_STOPPED` whatever the bridge is doing. The mock
 * answered the stop with the unreachable bridge's retry code instead, which
 * `isHueStopCodeOk` reads as a stop that failed — so a Hue left out of a
 * `[usb, hue]` start stayed listed active and the HUE chip read STREAMING
 * beside the left-out notice, a state the real backend cannot produce.
 */
describe("stop_hue_stream answers as Rust's local stop does", () => {
  it("reports HUE_STREAM_STOPPED against an unreachable bridge, and Idle until the next start", async () => {
    setWorld(SCENARIOS["hue-unreachable"].build());
    const start = (await dispatch(HUE_COMMANDS.START_STREAM)) as HueRuntimeCommandResult;
    expect(start.active).toBe(false);

    const stop = (await dispatch(HUE_COMMANDS.STOP_STREAM)) as HueRuntimeCommandResult;
    expect(stop.status.code).toBe(HUE_RUNTIME_STATUS.STREAM_STOPPED);
    expect(isHueStopCodeOk(stop.status.code)).toBe(true);

    const status = (await dispatch(HUE_COMMANDS.GET_STREAM_STATUS)) as HueRuntimeCommandResult;
    expect(status.status.state).toBe(HUE_RUNTIME_STATES.IDLE);

    // Idle, so a new start meets the strict gate, not a retry the stop cancelled.
    const restart = (await dispatch(HUE_COMMANDS.START_STREAM)) as HueRuntimeCommandResult;
    expect(restart.status.code).toBe(HUE_RUNTIME_STATUS.CONFIG_NOT_READY_GATE_BLOCKED);
    expect(restart.status.state).toBe(HUE_RUNTIME_STATES.IDLE);
  });

  it("reports HUE_STREAM_STOPPED against a rejected key, which only the next start turns into Failed", async () => {
    const world = SCENARIOS["hue-key-expired"].build();
    setWorld(world);

    const stop = (await dispatch(HUE_COMMANDS.STOP_STREAM)) as HueRuntimeCommandResult;
    expect(stop.status.code).toBe(HUE_RUNTIME_STATUS.STREAM_STOPPED);

    const start = (await dispatch(HUE_COMMANDS.START_STREAM)) as HueRuntimeCommandResult;
    expect(start.status.code).toBe(HUE_RUNTIME_STATUS.AUTH_INVALID_CREDENTIALS);
    expect(start.status.state).toBe(HUE_RUNTIME_STATES.FAILED);
  });
});

/**
 * `discover_hue_bridges`, `verify_hue_bridge_ip`, `pair_hue_bridge`,
 * `list_hue_entertainment_areas` and `check_hue_stream_readiness` all shared
 * the wide `HueOnboardingWireStatusCode` union (or, for pairing, the equally
 * wide `HueStatusCode`) the way `validate_hue_credentials` did before #386 —
 * so a fixture answering with a sibling command's code, or a frontend-minted
 * code that never reaches the wire, still satisfied the type and passed
 * `typecheck:mock` clean. Only `pair`, `list-areas` and `check-readiness` had
 * drifted codes; `discover` and `verify` are covered here as a narrowing
 * regression guard, not because they changed.
 */
describe("the five onboarding handlers answer with their own command's codes, not a sibling's", () => {
  it("pair_hue_bridge reports the wire's HUE_PAIRING_LINK_BUTTON_NOT_PRESSED, not the frontend-minted PENDING code", async () => {
    setWorld(SCENARIOS["hue-link-button"].build());

    const result = (await dispatch(HUE_COMMANDS.PAIR_BRIDGE)) as HuePairBridgeResponse;

    expect(result.status.code).toBe(HUE_STATUS.PAIRING_LINK_BUTTON_NOT_PRESSED);
    expect(result.status.code).not.toBe("HUE_PAIRING_PENDING_LINK_BUTTON");
  });

  it("list_hue_entertainment_areas reports HUE_AREA_LIST_FAILED for an unreachable bridge, not verify's HUE_IP_UNREACHABLE", async () => {
    setWorld(SCENARIOS["hue-unreachable"].build());

    const result = (await dispatch(
      HUE_COMMANDS.LIST_ENTERTAINMENT_AREAS,
    )) as HueEntertainmentAreaListResponse;

    expect(result.status.code).toBe(HUE_STATUS.AREA_LIST_FAILED);
    expect(result.areas).toEqual([]);
  });

  it("list_hue_entertainment_areas reports its own HUE_AREA_LIST_OK on success, not discovery's HUE_DISCOVERY_OK", async () => {
    setWorld(SCENARIOS.furnished.build());

    const result = (await dispatch(
      HUE_COMMANDS.LIST_ENTERTAINMENT_AREAS,
    )) as HueEntertainmentAreaListResponse;

    expect(result.status.code).toBe(HUE_STATUS.AREA_LIST_OK);
    expect(result.areas.length).toBeGreaterThan(0);
  });

  it("check_hue_stream_readiness reports HUE_STREAM_READINESS_FAILED for an unreachable bridge, not verify's HUE_IP_UNREACHABLE", async () => {
    setWorld(SCENARIOS["hue-unreachable"].build());

    const result = (await dispatch(
      HUE_COMMANDS.CHECK_STREAM_READINESS,
    )) as HueStreamReadinessResponse;

    expect(result.status.code).toBe(HUE_STATUS.STREAM_READINESS_FAILED);
    expect(result.readiness.ready).toBe(false);
  });

  it("check_hue_stream_readiness reports its own HUE_STREAM_READY on success, not verify's HUE_IP_VALID", async () => {
    setWorld(SCENARIOS.furnished.build());

    const result = (await dispatch(
      HUE_COMMANDS.CHECK_STREAM_READINESS,
    )) as HueStreamReadinessResponse;

    expect(result.status.code).toBe(HUE_STATUS.STREAM_READY);
    expect(result.readiness.ready).toBe(true);
  });

  it("check_hue_stream_readiness reports HUE_STREAM_NOT_READY with the active-streamer sentinel, not a bare unreachable code", async () => {
    const world = SCENARIOS.furnished.build();
    setWorld(world);
    mutate((w) => {
      w.hue.activeStreamerElsewhere = true;
    });

    const result = (await dispatch(
      HUE_COMMANDS.CHECK_STREAM_READINESS,
    )) as HueStreamReadinessResponse;

    expect(result.status.code).toBe(HUE_STATUS.STREAM_NOT_READY);
    expect(result.readiness.reasons).toContain(HUE_READINESS_REASON.ACTIVE_STREAMER);
  });

  it("start_hue_stream is gate-blocked by a foreign streamer, and says so in details", async () => {
    setWorld(SCENARIOS.furnished.build());
    mutate((w) => {
      w.hue.streaming = false;
      w.hue.activeStreamerElsewhere = true;
    });

    const result = (await dispatch(HUE_COMMANDS.START_STREAM)) as HueRuntimeCommandResult;

    expect(result.active).toBe(false);
    expect(result.status.code).toBe(HUE_RUNTIME_STATUS.CONFIG_NOT_READY_GATE_BLOCKED);
    expect(result.status.state).toBe(HUE_RUNTIME_STATES.IDLE);
    expect(result.status.details).toContain(HUE_READINESS_REASON.ACTIVE_STREAMER);
  });
});

// Relaunching straight after an unclean exit: the bridge still counts the old
// session as its streamer for 10–20 s. The real start fails its strict gate
// there, which is the refusal the boot restore's busy retry keys on.
describe("a held entertainment area", () => {
  it("gates start_hue_stream to Idle / CONFIG_NOT_READY_GATE_BLOCKED, as start_with_evidence does", () => {
    const world = SCENARIOS["hue-busy-at-boot"].build();
    world.hue.activeStreamerReleasesAt = null;
    setWorld(world);

    const result = call(HUE_COMMANDS.START_STREAM) as HueRuntimeCommandResult;

    expect(result.active).toBe(false);
    expect(result.status.code).toBe(HUE_RUNTIME_STATUS.CONFIG_NOT_READY_GATE_BLOCKED);
    expect(result.status.state).toBe(HUE_RUNTIME_STATES.IDLE);
  });

  it("frees the area by itself once the scheduled release passes", () => {
    setWorld(SCENARIOS["hue-busy-at-boot"].build());
    const held = call(HUE_COMMANDS.CHECK_STREAM_READINESS) as HueStreamReadinessResponse;
    expect(held.readiness.reasons).toEqual([HUE_READINESS_REASON.ACTIVE_STREAMER]);

    mutate((w) => {
      w.hue.activeStreamerReleasesAt = Date.now() - 1;
    });

    const free = call(HUE_COMMANDS.CHECK_STREAM_READINESS) as HueStreamReadinessResponse;
    expect(free.status.code).toBe(HUE_STATUS.STREAM_READY);
    const started = call(HUE_COMMANDS.START_STREAM) as HueRuntimeCommandResult;
    expect(started.active).toBe(true);
  });

  // The walk `usb-hue-busy-at-boot` exists for: USB alone at once, Hue added later.
  it("with a strip plugged in, gates [usb, hue] on Hue but runs [usb], then takes Hue once freed", () => {
    setWorld(SCENARIOS["usb-hue-busy-at-boot"].build());
    const apply = (targets: string[]) =>
      call(DEVICE_COMMANDS.SET_LIGHTING_MODE, { payload: { kind: "ambilight", targets } }) as ModeCommandResult;

    expect((call(HUE_COMMANDS.START_STREAM) as HueRuntimeCommandResult).status.code).toBe(
      HUE_RUNTIME_STATUS.CONFIG_NOT_READY_GATE_BLOCKED,
    );
    expect(apply(["usb", "hue"]).status.code).toBe("HUE_NOT_READY");
    expect(apply(["usb"]).mode).toEqual(expect.objectContaining({ kind: "ambilight", targets: ["usb"] }));

    mutate((w) => {
      w.hue.activeStreamerReleasesAt = Date.now() - 1;
    });
    expect((call(HUE_COMMANDS.START_STREAM) as HueRuntimeCommandResult).active).toBe(true);
    expect(apply(["usb", "hue"]).mode).toEqual(
      expect.objectContaining({ kind: "ambilight", targets: ["usb", "hue"] }),
    );
  });
});

/**
 * The health snapshot is derived from the same world the fixtures above read,
 * so the chip, the Devices card and the notices cannot disagree with them.
 */
describe("the health monitor fixture reads the world the other Hue fixtures read", () => {
  const health = () => call(HUE_HEALTH_COMMANDS.WATCH_HUE_HEALTH, { watch: { visible: true, areaReadiness: true } }) as HueHealthSnapshot;

  it("calls a paired, reachable bridge reachable and reads the saved area", () => {
    setWorld(SCENARIOS.furnished.build());
    const snapshot = health();

    expect(snapshot.configured).toBe(true);
    expect(snapshot.bridge.verdict).toBe("reachable");
    expect(snapshot.area?.status.code).toBe(HUE_STATUS.STREAM_READY);
  });

  it("tells a refused key from a bridge that is gone", () => {
    setWorld(SCENARIOS["hue-key-expired"].build());
    expect(health().bridge.verdict).toBe("credentialRejected");

    setWorld(SCENARIOS["hue-unreachable"].build());
    expect(health().bridge.verdict).toBe("unreachable");
  });

  it("reports nothing to probe when never paired", () => {
    setWorld(SCENARIOS.empty.build());
    const snapshot = health();

    expect(snapshot.configured).toBe(false);
    expect(snapshot.bridge.verdict).toBeNull();
    expect(snapshot.area).toBeNull();
  });

  it("moves the revision when the world changes, and only then", () => {
    setWorld(SCENARIOS.furnished.build());
    const first = health().revision;
    expect(health().revision).toBe(first);

    mutate((w) => {
      w.hue.reachable = false;
    });
    expect(health().revision).toBeGreaterThan(first);
  });
});
