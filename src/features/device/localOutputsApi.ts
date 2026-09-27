import { DEVICE_COMMANDS, type LocalOutputsSnapshot } from "@/shared/contracts/device";
import { invokeCommand } from "@/shared/ipcApi";

/** What Rust holds of the local outputs. Never rejects on Rust's side. */
export async function getLocalOutputs(): Promise<LocalOutputsSnapshot> {
  return invokeCommand(DEVICE_COMMANDS.GET_LOCAL_OUTPUTS);
}
