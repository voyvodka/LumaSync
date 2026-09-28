/**
 * Where Settings → Help sends the user. Each is opened by the opener plugin's
 * `<a target="_blank">` handler, so each must stay inside the `opener:allow-open-url`
 * scope in `src-tauri/capabilities/default.json`.
 *
 * Nothing here sends anything: the issue link only pre-fills a form in the
 * user's browser, where they read, edit and submit it — or close the tab.
 */

import { REPO_URL } from "@/shared/lib/issueReport";

export { buildIssueReportUrl, detectOsName, REPO_URL, type OsName } from "@/shared/lib/issueReport";

export const SITE_URL = "https://lumasync.app";
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const DISCUSSIONS_URL = `${REPO_URL}/discussions`;

/** The release page of the running build; tags are `v` + the version, prereleases included. */
export function releaseNotesUrl(appVersion: string): string {
  return `${REPO_URL}/releases/tag/v${appVersion}`;
}
