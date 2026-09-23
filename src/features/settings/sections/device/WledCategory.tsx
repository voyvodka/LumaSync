import { useActiveWledSink } from "@/features/device/useWledSink";
import { WledDevicePicker } from "../WledDevicePicker";

export interface WledCategoryProps {
  isActive: boolean;
}

export function WledCategory({ isActive }: WledCategoryProps) {
  const { activeWledIp, savedSink, restoreOutcome, markConnected } = useActiveWledSink();

  return (
    <div className="lm-device-cat-body" hidden={!isActive}>
      <WledDevicePicker
        activeWledIp={activeWledIp}
        savedSink={savedSink}
        restoreOutcome={restoreOutcome}
        onConnected={(device) => { void markConnected(device); }}
      />
    </div>
  );
}
