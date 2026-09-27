/** Both halves of one invariant: Rust drives one local output at a time (`LocalOutputRegistry`), so the persisted record of the loser must be cleared or its boot path will evict the winner. See docs/architecture/device-output.md. */
import type { ShellState } from "@/shared/contracts/shell";
import type { WledUdpSinkConfig } from "@/shared/contracts/device";
import { savedWledSink } from "@/features/strips/model/stripSelectors";
import { withSerialTransport, withWledTransport } from "@/features/strips/model/stripWrites";

/** `shellStore.update`: a revision-guarded read-modify-write. */
export type ShellStateUpdater = (update: (current: ShellState) => Partial<ShellState> | null) => Promise<ShellState>;

/** `sinkFor` sees the device saved before, in the same read the write is based on. */
export async function persistWledSink(
  updateShellState: ShellStateUpdater,
  sinkFor: (previous: WledUdpSinkConfig | undefined) => WledUdpSinkConfig,
): Promise<WledUdpSinkConfig> {
  let sink: WledUdpSinkConfig | undefined;
  await updateShellState((current) => {
    sink = sinkFor(savedWledSink(current));
    return withWledTransport(current, sink);
  });
  return sink!;
}

export async function persistSerialPort(updateShellState: ShellStateUpdater, portName: string): Promise<void> {
  await updateShellState((current) => withSerialTransport(current, portName));
}
