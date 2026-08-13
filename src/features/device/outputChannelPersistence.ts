/** Both halves of one invariant: `ActiveSinkRegistry` holds a single sink per output channel, so the persisted record of the loser must be cleared or its boot path will evict the winner. See docs/architecture/device-output.md. */
import type { ShellState } from "@/shared/contracts/shell";
import type { WledUdpSinkConfig } from "@/shared/contracts/device";

export type ShellStateWriter = (partial: Partial<ShellState>) => Promise<void>;

export async function persistWledSink(
  saveShellState: ShellStateWriter,
  sink: WledUdpSinkConfig,
): Promise<void> {
  await saveShellState({ lastWledSink: sink, lastSuccessfulPort: undefined });
}

export async function persistSerialPort(
  saveShellState: ShellStateWriter,
  portName: string,
): Promise<void> {
  await saveShellState({ lastSuccessfulPort: portName, lastWledSink: undefined });
}
