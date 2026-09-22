/**
 * The DevPanel's "Reload app" button and every scenario switch navigate
 * through this module. `useShellBootstrap` only restores `lastSection` when
 * `sessionStorage["lumasync_session"]` is already `"1"` on the *next* page —
 * its own bootstrap effect writes that flag, but only after `await
 * loadShellState()` resolves. A developer who reloads before that settles
 * beats the write: the flag stays unset across the navigation and the
 * restored section is lost. `reloadWithScenario` must write the flag before
 * it navigates, not race it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { reloadWithScenario, SESSION_REFRESH_FLAG_KEY } from "../reload";

describe("reloadWithScenario", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("writes the session-refresh flag before navigating", () => {
    let flagAtNavigateTime: string | null = null;
    const navigate = vi.fn((_url: string) => {
      flagAtNavigateTime = sessionStorage.getItem(SESSION_REFRESH_FLAG_KEY);
    });

    reloadWithScenario("hue-only", navigate);

    expect(navigate).toHaveBeenCalledTimes(1);
    // The critical assertion: the flag was readable *inside* the navigate
    // callback, not merely by the time this line runs — this is what
    // catches the flag write losing the race to the navigation itself.
    expect(flagAtNavigateTime).toBe("1");
    expect(sessionStorage.getItem(SESSION_REFRESH_FLAG_KEY)).toBe("1");
  });

  it("carries the requested scenario id in the navigated URL", () => {
    const navigate = vi.fn();

    reloadWithScenario("capture-denied", navigate);

    expect(navigate).toHaveBeenCalledTimes(1);
    const [url] = navigate.mock.calls[0] as [string];
    expect(new URL(url).searchParams.get("scenario")).toBe("capture-denied");
  });
});
