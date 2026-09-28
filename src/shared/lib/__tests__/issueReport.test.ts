import { describe, expect, it } from "vitest";

import { buildIssueReportUrl } from "../issueReport";

describe("buildIssueReportUrl with a crash", () => {
  it("puts the error in the title and under Logs and Evidence", () => {
    const url = new URL(buildIssueReportUrl("1.5.5", "macOS", { message: "TypeError: x is null", stack: "at Foo (a.tsx:1)" }));
    expect(url.searchParams.get("title")).toBe("[Bug] TypeError: x is null");
    const body = url.searchParams.get("body") ?? "";
    expect(body).toContain("- App version: 1.5.5");
    expect(body.indexOf("TypeError: x is null")).toBeGreaterThan(body.indexOf("## Logs and Evidence"));
  });

  // GitHub refuses a new-issue URL past a few thousand characters; a React stack runs far longer.
  it("cuts a long stack short so the form still opens", () => {
    const stack = "at frame (file.tsx:1:1)\n".repeat(2000);
    const url = buildIssueReportUrl("1.5.5", "macOS", { message: "Error: long", stack });
    expect(url.length).toBeLessThan(8000);
    expect(new URL(url).searchParams.get("body")).toContain("…");
  });
});
