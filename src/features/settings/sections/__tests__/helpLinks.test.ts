import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildIssueReportUrl, detectOsName, DISCUSSIONS_URL } from "../helpLinks";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/131.0";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";

/** The opener plugin matches the scope as a glob in which `*` crosses `/` and `?`. */
function allowedByOpenerScope(url: string): boolean {
  const capability = JSON.parse(
    readFileSync(resolve(__dirname, "../../../../../src-tauri/capabilities/default.json"), "utf8"),
  ) as { permissions: Array<string | { identifier: string; allow?: Array<{ url: string }> }> };
  const entry = capability.permissions.find(
    (permission) => typeof permission !== "string" && permission.identifier === "opener:allow-open-url",
  );
  const patterns = typeof entry === "object" && entry.allow ? entry.allow.map((scope) => scope.url) : [];
  return patterns.some((pattern) => {
    const source = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${source}$`).test(url);
  });
}

describe("help links", () => {
  it("names the OS family and never a version the webview pins", () => {
    expect(detectOsName(MAC)).toBe("macOS");
    expect(detectOsName(WINDOWS)).toBe("Windows");
    expect(detectOsName(LINUX)).toBe("Linux");
    expect(detectOsName("")).toBeNull();
  });

  it("pre-fills the bug template with the version and OS, and leaves the rest to the user", () => {
    const url = new URL(buildIssueReportUrl("1.5.5-rc.6", "macOS"));
    expect(url.origin + url.pathname).toBe("https://github.com/voyvodka/LumaSync/issues/new");
    expect(url.searchParams.get("template")).toBe("bug_report.md");
    const body = url.searchParams.get("body") ?? "";
    expect(body).toContain("- OS: macOS (version: )");
    expect(body).toContain("- App version: 1.5.5-rc.6");
    expect(body).toContain("## Steps to Reproduce");
  });

  // A link outside the scope is refused by the opener with no word to the user.
  it("stays inside the opener scope the main window is granted", () => {
    expect(allowedByOpenerScope(buildIssueReportUrl("1.5.5", "Windows"))).toBe(true);
    expect(allowedByOpenerScope(DISCUSSIONS_URL)).toBe(true);
    expect(allowedByOpenerScope("https://github.com/voyvodka/LumaSync/settings")).toBe(false);
    expect(allowedByOpenerScope("https://github.com/someone-else/repo/issues/new")).toBe(false);
  });
});
