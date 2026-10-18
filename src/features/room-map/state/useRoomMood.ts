import { useMemo } from "react";

import { useRunningLightingMode } from "@/features/mode/state/lightingControl";
import { usePreference } from "@/features/persistence/preferences";
import { type RoomMood, roomMood } from "@/features/room-view/model/roomMood";

export function useRoomMood(): RoomMood {
  const running = useRunningLightingMode();
  const ambient = usePreference("roomMapAmbient");
  return useMemo(() => roomMood(running, ambient / 100), [running, ambient]);
}
