/**
 * A new-issue form on GitHub, pre-filled. Nothing is sent: it opens in the user's browser, where
 * they read, edit and submit it — or close the tab. Here, not in Settings, because the error
 * screen builds one too and may import nothing outside `shared/`: the feature module that threw
 * might be the one it would pull in.
 */

export const REPO_URL = "https://github.com/voyvodka/LumaSync";

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

/** How much of a crash goes into the form: a long stack would push the URL past what GitHub takes. */
const CRASH_LIMIT = 1500;

/** What the error screen adds: the error in the reporter's own form, cut short. */
export interface CrashReport {
  message: string;
  stack?: string | null;
}

function crashSection(crash: CrashReport): string {
  const text = [crash.message, crash.stack ?? ""].filter(Boolean).join("\n");
  const cut = text.length > CRASH_LIMIT ? `${text.slice(0, CRASH_LIMIT)}\n…` : text;
  return ["", "The app showed \"Something went wrong\":", "", "```", cut, "```", ""].join("\n");
}

/** A new-issue form on GitHub, from the bug template, with version and OS filled in, and a crash when there was one. */
export function buildIssueReportUrl(appVersion: string, os: OsName | null, crash?: CrashReport): string {
  const body = issueBody(appVersion, os);
  const params = new URLSearchParams({
    template: "bug_report.md",
    title: crash ? `[Bug] ${crash.message.slice(0, 80)}` : "[Bug] ",
    body: crash ? body.replace("## Logs and Evidence\n", `## Logs and Evidence\n${crashSection(crash)}`) : body,
  });
  return `${REPO_URL}/issues/new?${params.toString()}`;
}
