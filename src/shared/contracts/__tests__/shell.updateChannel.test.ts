import { describe, expect, it } from "vitest";

import { defaultUpdateChannel, resolveUpdateChannel } from "../shell";

// Mirrors `resolve_update_channel` in src-tauri/src/commands/updater.rs; the
// two must agree or the Settings switch shows a channel Rust does not check.
describe("update channel", () => {
  it("defaults a prerelease build to beta and a release to stable", () => {
    expect(defaultUpdateChannel("1.5.5-rc.6")).toBe("beta");
    expect(defaultUpdateChannel("2.0.0-beta")).toBe("beta");
    expect(defaultUpdateChannel("1.5.5")).toBe("stable");
  });

  // Build metadata follows `+` and is not a prerelease, even when it has a hyphen.
  it("reads only the part before build metadata", () => {
    expect(defaultUpdateChannel("1.5.5+build-7")).toBe("stable");
    expect(defaultUpdateChannel("1.5.5-rc.1+build-7")).toBe("beta");
  });

  it("lets an explicit choice win on either build", () => {
    for (const version of ["1.5.5", "1.5.5-rc.6"]) {
      expect(resolveUpdateChannel("beta", version)).toBe("beta");
      expect(resolveUpdateChannel("stable", version)).toBe("stable");
    }
  });

  it("falls back to the build's default only when nothing was chosen", () => {
    expect(resolveUpdateChannel(undefined, "1.5.5-rc.6")).toBe("beta");
    expect(resolveUpdateChannel(undefined, "1.5.5")).toBe("stable");
    // Rust reads a non-string as absent too.
    expect(resolveUpdateChannel(3, "1.5.5-rc.6")).toBe("beta");
  });

  // A corrupt store must never move an install onto prereleases.
  it("reads any other stored string as stable, even on a prerelease", () => {
    for (const value of ["", "Beta", "nightly", "beta "]) {
      expect(resolveUpdateChannel(value, "1.5.5-rc.6")).toBe("stable");
    }
  });
});
