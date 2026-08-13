import { useEffect, useRef, useState } from "react";
import { shellStore } from "@/features/persistence/shellStore";

export interface UseRoomMapGridSettingsReturn {
  showGrid: boolean;
  setShowGrid: React.Dispatch<React.SetStateAction<boolean>>;
  gridStrokeWidth: number;
  setGridStrokeWidth: React.Dispatch<React.SetStateAction<number>>;
  showHueZones: boolean;
  setShowHueZones: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useRoomMapGridSettings(): UseRoomMapGridSettingsReturn {
  const [showGrid, setShowGrid] = useState(true);
  const [gridStrokeWidth, setGridStrokeWidth] = useState(0.5);
  // W4-J #3 — visibility toggle for Hue zone bounds. Default ON so a
  // newly authored zone is visible without first selecting it; user
  // can flip OFF to declutter the canvas while editing other objects.
  const [showHueZones, setShowHueZones] = useState(true);
  const gridSettingsLoaded = useRef(false);

  // Load persisted grid + Hue zone visibility settings on mount
  useEffect(() => {
    void shellStore.load().then((state) => {
      if (state.roomMapShowGrid !== undefined) setShowGrid(state.roomMapShowGrid);
      if (state.roomMapGridStrokeWidth !== undefined) setGridStrokeWidth(state.roomMapGridStrokeWidth);
      if (state.roomMapShowHueZones !== undefined) setShowHueZones(state.roomMapShowHueZones);
      gridSettingsLoaded.current = true;
    });
  }, []);

  // Persist grid + Hue zone visibility settings when they change (skip initial load).
  // Must stay declared after the load effect above: `gridSettingsLoaded` is what
  // stops the mount pass from writing defaults back over the stored values.
  useEffect(() => {
    if (!gridSettingsLoaded.current) return;
    void shellStore.save({
      roomMapShowGrid: showGrid,
      roomMapGridStrokeWidth: gridStrokeWidth,
      roomMapShowHueZones: showHueZones,
    });
  }, [showGrid, gridStrokeWidth, showHueZones]);

  return {
    showGrid,
    setShowGrid,
    gridStrokeWidth,
    setGridStrokeWidth,
    showHueZones,
    setShowHueZones,
  };
}
