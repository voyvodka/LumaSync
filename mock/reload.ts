/**
 * The mock's own "reload" — the DevPanel's Reload App button and every
 * scenario switch — is a same-tab navigation, exactly what
 * `useShellBootstrap`'s `lumasync_session` sessionStorage flag exists to
 * detect. That hook only writes the flag itself after `await
 * loadShellState()` resolves, so a developer who reloads before that
 * settles beats the write to the navigation: the flag is still unset on the
 * next page, `isPageRefresh` reads false, and `lastSection` silently resets
 * to the default section instead of restoring. Setting the flag here,
 * synchronously and ahead of navigation, removes the race rather than
 * hoping the effect wins it — this genuinely *is* a same-tab reload, so
 * writing the flag early does not misrepresent what happened.
 *
 * Split out of `boot.ts` so it can be unit tested without importing that
 * file's top-level side effects (`mockIPC`, `restoreWorld`, panel mount).
 */

export const SESSION_REFRESH_FLAG_KEY = "lumasync_session";

/** Defaults to a real navigation; tests inject a spy instead. */
export function reloadWithScenario(
  id: string,
  navigate: (url: string) => void = (url) => {
    window.location.href = url;
  },
): void {
  sessionStorage.setItem(SESSION_REFRESH_FLAG_KEY, "1");
  const url = new URL(window.location.href);
  url.searchParams.set("scenario", id);
  navigate(url.toString());
}
