import { act } from "@testing-library/react";
import { vi } from "vitest";

/** Advance fake timers inside `act`, so the state updates they trigger have landed before the next assertion. */
export async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
