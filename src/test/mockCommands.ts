/**
 * Typed test doubles for the Tauri command boundary, built from the same
 * `CommandMap` (`shared/contracts/ipc.ts`) the bridges and the dev mock use. A
 * fixture that answers a command with the wrong shape, or names a command that
 * does not exist, fails `bun run typecheck` instead of passing a test against a
 * payload the backend can never send.
 */
import { vi, type Mock } from "vitest";

import type {
  CommandArgsTuple,
  CommandInvoker,
  CommandName,
  CommandResult,
} from "@/shared/contracts/ipc";

/** A command's answer: the value itself, or a function of the invoke args. A
 * function that throws (or returns a rejected promise) makes the command
 * reject, which is how a transport failure is simulated. */
export type CommandFixture<K extends CommandName> =
  | CommandResult<K>
  | ((...args: CommandArgsTuple<K>) => CommandResult<K> | Promise<CommandResult<K>>);

export type CommandFixtures = { [K in CommandName]?: CommandFixture<K> };

type RecordedInvoke = (command: CommandName, args?: unknown) => Promise<unknown>;

/** A {@link CommandInvoker} that also records its calls. */
export type MockCommandInvoker = CommandInvoker & Mock<RecordedInvoke>;

async function answer(fixtures: CommandFixtures, command: string, args: unknown[]): Promise<unknown> {
  if (!Object.prototype.hasOwnProperty.call(fixtures, command)) {
    throw new Error(`mockCommands: no fixture for "${command}"`);
  }
  const fixture: unknown = fixtures[command as CommandName];
  return typeof fixture === "function" ? await fixture(...args) : fixture;
}

/**
 * An injectable invoker for the `*Api.ts` functions that take one. A command
 * with no fixture rejects, naming itself, so a test never passes on an
 * `undefined` it did not ask for.
 */
export function mockCommands(fixtures: CommandFixtures): MockCommandInvoker {
  const invoker = vi.fn<RecordedInvoke>((command, ...args) => answer(fixtures, command, args));
  return invoker as unknown as MockCommandInvoker;
}

/**
 * The same fixtures as an implementation for a mocked
 * `@tauri-apps/api/core` `invoke`, for tests that render a whole tree rather
 * than call one bridge: `vi.mocked(invoke).mockImplementation(invokeFromCommands({...}))`.
 * Anything else the tree invokes — a `plugin:*` command, an unmapped one —
 * rejects with its name.
 */
export function invokeFromCommands(
  fixtures: CommandFixtures,
): (command: string, args?: unknown) => Promise<never> {
  return (command, ...args) => answer(fixtures, command, args) as Promise<never>;
}
