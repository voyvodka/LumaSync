/**
 * Where Settings → Help sends the user. Each is opened by the opener plugin's
 * `<a target="_blank">` handler, so each must stay inside the `opener:allow-open-url`
 * scope in `src-tauri/capabilities/default.json`.
 *
 * Nothing here sends anything: the issue link only pre-fills a form in the
 * user's browser, where they read, edit and submit it — or close the tab.
 */

const REPO_URL = "https://github.com/voyvodka/LumaSync";

export const DISCUSSIONS_URL = `${REPO_URL}/discussions`;

export type OsName = "macOS" | "Windows" | "Linux";

/**
 * The OS family only. The webview's user agent pins the version (macOS reports
 * 10.15.7 whatever runs, Windows 11 reads as 10), so a version from it would be
 * wrong more often than missing — the form leaves it for the user to fill in.
 */
export function detectOsName(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): OsName | null {
  if (/Mac/i.test(userAgent)) return "macOS";
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/Linux|X11/i.test(userAgent)) return "Linux";
  return null;
}

/**
 * The repository's bug template with the environment filled in. English on
 * purpose, whatever the interface language: it is the text of an issue in an
 * English-language tracker, never shown inside the app.
 */
function issueBody(appVersion: string, os: OsName | null): string {
  return [
    "## Description",
    "",
    "",
    "## Steps to Reproduce",
    "",
    "1.",
    "2.",
    "3.",
    "",
    "## Expected Behavior",
    "",
    "",
    "## Actual Behavior",
    "",
    "",
    "## Environment",
    "",
    `- OS: ${os ?? ""} (version: )`,
    `- App version: ${appVersion}`,
    "- Device/setup (USB strip, WLED, Hue):",
    "",
    "## Logs and Evidence",
    "",
    "<!-- Settings → Help → Open log folder. Attach the log file if you can. -->",
    "",
  ].join("\n");
}

/** A new-issue form on GitHub, from the bug template, with version and OS filled in. */
export function buildIssueReportUrl(appVersion: string, os: OsName | null): string {
  const params = new URLSearchParams({
    template: "bug_report.md",
    title: "[Bug] ",
    body: issueBody(appVersion, os),
  });
  return `${REPO_URL}/issues/new?${params.toString()}`;
}
