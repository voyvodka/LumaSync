/** The typed `invoke()`. Every `*Api.ts` bridge calls commands through this, so
 * a command name, its payload and its result are all checked against
 * `CommandMap` in `shared/contracts/ipc.ts`. */
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";

import type { CommandArgsTuple, CommandInvoker, CommandName, CommandResult } from "@/shared/contracts/ipc";

export type { CommandInvoker };

export const invokeCommand: CommandInvoker = <K extends CommandName>(
  command: K,
  ...args: CommandArgsTuple<K>
): Promise<CommandResult<K>> =>
  // A no-arg command is sent without a second argument, not with `undefined`:
  // tests assert the bare `invoke(name)` call shape. The cast only drops the
  // index signature `InvokeArgs` wants; the shape was checked by the map.
  args.length === 0
    ? invoke<CommandResult<K>>(command)
    : invoke<CommandResult<K>>(command, args[0] as InvokeArgs);
