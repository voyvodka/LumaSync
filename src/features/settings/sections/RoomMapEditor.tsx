import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useRoomMapPersist } from "./room-map/useRoomMapPersist";
import { RoomMapCanvas } from "./room-map/RoomMapCanvas";
import { RoomMapToolbar } from "./room-map/RoomMapToolbar";
import { RoomMapSettingsPopover } from "./room-map/RoomMapSettingsPopover";
import { RoomMapEmptyHint } from "./room-map/RoomMapEmptyHint";
import { FurnitureObject } from "./room-map/FurnitureObject";
import { TvAnchorObject } from "./room-map/TvAnchorObject";
import { UsbStripObject } from "./room-map/UsbStripObject";
import { HueChannelOverlay } from "./room-map/HueChannelOverlay";
import { ObjectListPanel } from "./room-map/ObjectListPanel";
import { deriveZones, type ZoneDeriveResult } from "./room-map/deriveZones";
import { useSnapGuides } from "./room-map/useSnapGuides";
import { SnapGuideOverlay } from "./room-map/SnapGuideOverlay";
import { OriginMarker } from "./room-map/OriginMarker";
import { ContextMenu, type ContextMenuAction } from "./room-map/ContextMenu";
import { LeftToolbar } from "./room-map/LeftToolbar";
import { PropertyBar } from "./room-map/PropertyBar";
import { TemplateSelector } from "./room-map/TemplateSelector";
import { ZoneDeriveOverlay } from "./room-map/ZoneDeriveOverlay";
import type {
  FurniturePlacement,
  TvAnchorPlacement,
  UsbStripPlacement,
  HueChannelPlacement,
  RoomDimensions,
  ZoneDefinition,
} from "../../../shared/contracts/roomMap";
import type { LedSegmentCounts } from "../../calibration/model/contracts";
import { shellStore } from "../../persistence/shellStore";

interface RoomMapEditorProps {
  onZoneCountsConfirmed?: (counts: LedSegmentCounts) => void;
}

// Hex colors matching ZONE_COLORS Tailwind classes (for inline boxShadow ring)
const ZONE_COLOR_HEX = ["#3b82f6", "#10b981", "#a855f7", "#f59e0b", "#f43f5e", "#06b6d4"];

function getZoneColorHex(index: number): string {
  return ZONE_COLOR_HEX[index % ZONE_COLOR_HEX.length];
}


export function RoomMapEditor({ onZoneCountsConfirmed }: RoomMapEditorProps = {}) {
  const { t } = useTranslation("common");
  const { config, updateConfig, replaceConfig, resetConfig, undo, redo, canUndo, canRedo, loading, error } = useRoomMapPersist();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [derivePreview, setDerivePreview] = useState<ZoneDeriveResult | null>(null);
  const [showGrid, setShowGrid] = useState(true);
  const [gridStrokeWidth, setGridStrokeWidth] = useState(0.5);
  const gridSettingsLoaded = useRef(false);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [mouseCoord, setMouseCoord] = useState<{ x: number; y: number } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; currentLabel: string } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);

  // Track space key for pan mode — prevents object drag during space+click
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === " " && !e.repeat) setSpaceHeld(true); };
    const up = (e: KeyboardEvent) => { if (e.key === " ") setSpaceHeld(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // Load persisted grid settings on mount
  useEffect(() => {
    void shellStore.load().then((state) => {
      if (state.roomMapShowGrid !== undefined) setShowGrid(state.roomMapShowGrid);
      if (state.roomMapGridStrokeWidth !== undefined) setGridStrokeWidth(state.roomMapGridStrokeWidth);
      gridSettingsLoaded.current = true;
    });
  }, []);

  // Persist grid settings when they change (skip initial load)
  useEffect(() => {
    if (!gridSettingsLoaded.current) return;
    void shellStore.save({
      roomMapShowGrid: showGrid,
      roomMapGridStrokeWidth: gridStrokeWidth,
    });
  }, [showGrid, gridStrokeWidth]);

  // Zone management state
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);
  const [objectPanelOpen, setObjectPanelOpen] = useState(true);

  // Snap guides
  const { guides: snapGuides, onDragMove: snapDragMove, onDragEnd: snapDragEnd } = useSnapGuides(config);

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetId: string } | null>(null);

  const initialFitDone = useRef(false);

  useEffect(() => {
    const el = canvasContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width === 0 || height === 0) return;
        setCanvasSize({ w: width, h: height });

        // Fit-to-view once on the first real measurement from ResizeObserver
        if (!initialFitDone.current) {
          initialFitDone.current = true;
          const { widthMeters: wm, depthMeters: dm } = config.dimensions;
          const pad = 24;
          const fitZoom = Math.min(
            (width - pad * 2) / (wm * 80),
            (height - pad * 2) / (dm * 80),
          );
          const z = Math.max(0.3, Math.min(3, fitZoom));
          const roomW = wm * 80 * z;
          const roomH = dm * 80 * z;
          setZoom(z);
          setPanOffset({ x: (width - roomW) / 2, y: (height - roomH) / 2 });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { widthMeters, depthMeters } = config.dimensions;

  // Fixed physical scale — objects always render at this size regardless of canvas
  const pxPerMeter = 80;
  const gridStepM = widthMeters < 4 ? 0.5 : 1.0;
  const gridStepPx = gridStepM * pxPerMeter;

  // Derived
  const hasTv = !!config.tvAnchor;
  const hasUsb = config.usbStrips.length > 0;
  const derivePreviewActive = derivePreview !== null;
  const isEmpty =
    !config.tvAnchor &&
    config.furniture.length === 0 &&
    config.usbStrips.length === 0 &&
    config.hueChannels.length === 0;

  // Zone derivation handlers
  const handleDeriveZones = useCallback(() => {
    if (derivePreview) {
      // Toggle off if already active
      setDerivePreview(null);
      return;
    }
    const strip = config.usbStrips[0];
    const tv = config.tvAnchor;
    if (!strip || !tv) return;
    const result = deriveZones(strip, tv);
    if (result.counts.top + result.counts.right + result.counts.bottom + result.counts.left === 0) {
      return;
    }
    setDerivePreview(result);
  }, [config.usbStrips, config.tvAnchor, derivePreview]);

  const handleDeriveConfirm = useCallback(() => {
    if (!derivePreview) return;
    onZoneCountsConfirmed?.(derivePreview.counts);
    setDerivePreview(null);
  }, [derivePreview, onZoneCountsConfirmed]);

  const handleDeriveDiscard = useCallback(() => {
    setDerivePreview(null);
  }, []);

  // Handlers
  const handleAddTv = useCallback(() => {
    const newTv: TvAnchorPlacement = {
      x: widthMeters / 2 - 0.5,
      y: 0.3,
      width: 1.0,
      height: 0.1,
    };
    void updateConfig({ tvAnchor: newTv });
  }, [widthMeters, updateConfig]);

  const handleAddFurniture = useCallback(
    (type: FurniturePlacement["type"]) => {
      const id = `furniture-${crypto.randomUUID()}`;
      const newItem: FurniturePlacement = {
        id,
        type,
        x: widthMeters / 2 - 0.3,
        y: depthMeters / 2 - 0.3,
        width: 0.6,
        height: 0.6,
        label: t(`roomMap.furniture.type.${type}`),
      };
      void updateConfig({ furniture: [...config.furniture, newItem] });
    },
    [widthMeters, depthMeters, config.furniture, updateConfig, t],
  );

  const handleAddUsb = useCallback(() => {
    const stripId = `usb-${crypto.randomUUID()}`;
    const newStrip: UsbStripPlacement = {
      stripId,
      startX: 1,
      startY: 1,
      endX: widthMeters - 1,
      endY: 1,
      ledCount: 60,
    };
    void updateConfig({ usbStrips: [...config.usbStrips, newStrip] });
  }, [widthMeters, config.usbStrips, updateConfig]);

  const handleAddHue = useCallback(() => {
    const newChannel: HueChannelPlacement = {
      channelIndex: config.hueChannels.length,
      x: 0,
      y: 0,
      z: 0,
    };
    void updateConfig({ hueChannels: [...config.hueChannels, newChannel] });
  }, [config.hueChannels, updateConfig]);

  const handleAddImage = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (selected && typeof selected === "string") {
      const destPath = await invoke<string>("copy_background_image", { srcPath: selected });
      const fileName = destPath.split("/").pop() ?? "Image";
      const label = fileName.replace(/\.[^.]+$/, "");
      const id = crypto.randomUUID();
      const newLayer = { id, path: destPath, label, offsetX: 0, offsetY: 0, scale: 1 };
      await updateConfig({ imageLayers: [...config.imageLayers, newLayer] });
      setSelectedId(`img-${id}`);
    }
  }, [config.imageLayers, updateConfig]);

  const isLocked = useCallback(
    (id: string): boolean => {
      if (id === "tv") return !!config.tvAnchor?.locked;
      if (id.startsWith("furniture-")) return !!config.furniture.find((f) => f.id === id.replace("furniture-", ""))?.locked;
      if (id.startsWith("usb-")) return !!config.usbStrips.find((s) => s.stripId === id.replace("usb-", ""))?.locked;
      if (id.startsWith("hue-")) { const idx = parseInt(id.replace("hue-", ""), 10); return !!config.hueChannels[idx]?.locked; }
      if (id.startsWith("img-")) return !!config.imageLayers.find((l) => l.id === id.replace("img-", ""))?.locked;
      return false;
    },
    [config],
  );

  const deleteById = useCallback(
    (id: string) => {
      if (isLocked(id)) return;
      if (id.startsWith("img-")) {
        const imgId = id.replace("img-", "");
        void updateConfig({ imageLayers: config.imageLayers.filter((l) => l.id !== imgId) });
      } else if (id === "tv") {
        void updateConfig({ tvAnchor: undefined });
      } else if (id.startsWith("furniture-")) {
        const fId = id.replace("furniture-", "");
        void updateConfig({ furniture: config.furniture.filter((f) => f.id !== fId) });
      } else if (id.startsWith("usb-")) {
        const sId = id.replace("usb-", "");
        void updateConfig({ usbStrips: config.usbStrips.filter((s) => s.stripId !== sId) });
      } else if (id.startsWith("hue-")) {
        const idx = parseInt(id.replace("hue-", ""), 10);
        void updateConfig({ hueChannels: config.hueChannels.filter((_, i) => i !== idx) });
      }
      setSelectedId(null);
    },
    [config, updateConfig, isLocked],
  );

  const handleDelete = useCallback(() => {
    if (!selectedId) return;
    deleteById(selectedId);
  }, [selectedId, deleteById]);

  const handleRotate = useCallback(() => {
    if (!selectedId || !selectedId.startsWith("furniture-")) return;
    const fId = selectedId.replace("furniture-", "");
    const updated = config.furniture.map((f) => {
      if (f.id !== fId) return f;
      const current = f.rotation ?? 0;
      return { ...f, rotation: (current + 15) % 360 };
    });
    void updateConfig({ furniture: updated });
  }, [selectedId, config.furniture, updateConfig]);

  const handleDuplicate = useCallback(
    (id: string) => {
      const offset = 0.2;
      if (id.startsWith("furniture-")) {
        const fId = id.replace("furniture-", "");
        const src = config.furniture.find((f) => f.id === fId);
        if (!src) return;
        const dup = { ...src, id: crypto.randomUUID(), x: src.x + offset, y: src.y + offset };
        void updateConfig({ furniture: [...config.furniture, dup] });
        setSelectedId(`furniture-${dup.id}`);
      } else if (id.startsWith("usb-")) {
        const sId = id.replace("usb-", "");
        const src = config.usbStrips.find((s) => s.stripId === sId);
        if (!src) return;
        const dup = { ...src, stripId: crypto.randomUUID(), startX: src.startX + offset, startY: src.startY + offset, endX: src.endX + offset, endY: src.endY + offset };
        void updateConfig({ usbStrips: [...config.usbStrips, dup] });
        setSelectedId(`usb-${dup.stripId}`);
      }
    },
    [config.furniture, config.usbStrips, updateConfig],
  );

  const handleArrowNudge = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!selectedId) return;
      const arrowKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
      if (!arrowKeys.includes(e.key)) return;
      e.preventDefault();

      // Metre-based nudge step (0.1m default, 1.0m with Shift)
      const nudgeM = e.shiftKey ? 1.0 : 0.1;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = -nudgeM;
      if (e.key === "ArrowRight") dx = nudgeM;
      if (e.key === "ArrowUp") dy = -nudgeM;
      if (e.key === "ArrowDown") dy = nudgeM;

      if (selectedId === "tv" && config.tvAnchor) {
        void updateConfig({
          tvAnchor: { ...config.tvAnchor, x: config.tvAnchor.x + dx, y: config.tvAnchor.y + dy },
        });
      } else if (selectedId.startsWith("furniture-")) {
        const fId = selectedId.replace("furniture-", "");
        void updateConfig({
          furniture: config.furniture.map((f) =>
            f.id === fId ? { ...f, x: f.x + dx, y: f.y + dy } : f,
          ),
        });
      } else if (selectedId.startsWith("usb-")) {
        const sId = selectedId.replace("usb-", "");
        void updateConfig({
          usbStrips: config.usbStrips.map((s) =>
            s.stripId === sId
              ? { ...s, startX: s.startX + dx, startY: s.startY + dy, endX: s.endX + dx, endY: s.endY + dy }
              : s,
          ),
        });
      } else if (selectedId.startsWith("hue-")) {
        const idx = parseInt(selectedId.replace("hue-", ""), 10);
        // Hue channels: nudge in [-1,1] space; step = 0.05
        const hueStep = 0.05;
        let hdx = 0;
        let hdy = 0;
        if (e.key === "ArrowLeft") hdx = -hueStep;
        if (e.key === "ArrowRight") hdx = hueStep;
        // Hue Y: up = positive (towards front), CSS up = negative
        if (e.key === "ArrowUp") hdy = hueStep;
        if (e.key === "ArrowDown") hdy = -hueStep;
        void updateConfig({
          hueChannels: config.hueChannels.map((ch) =>
            ch.channelIndex === idx
              ? { ...ch, x: Math.max(-1, Math.min(1, ch.x + hdx)), y: Math.max(-1, Math.min(1, ch.y + hdy)) }
              : ch,
          ),
        });
      }
    },
    [selectedId, config, updateConfig],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Undo: Cmd+Z (Mac) / Ctrl+Z (Win/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        void undo();
        return;
      }
      // Redo: Cmd+Shift+Z (Mac) / Ctrl+Shift+Z (Win/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        void redo();
        return;
      }
      // Fit to view: Cmd+0 (Mac) / Ctrl+0 (Win/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === "0") {
        e.preventDefault();
        // Compute zoom level that fits room into canvas with 16px padding
        const pad = 16;
        const fitZoom = Math.min(
          (canvasSize.w - pad * 2) / (widthMeters * pxPerMeter),
          (canvasSize.h - pad * 2) / (depthMeters * pxPerMeter),
        );
        const newZoom = Math.max(0.3, Math.min(3, fitZoom));
        setZoom(newZoom);
        // Center the room in the canvas
        const roomW = widthMeters * pxPerMeter * newZoom;
        const roomH = depthMeters * pxPerMeter * newZoom;
        setPanOffset({
          x: (canvasSize.w - roomW) / 2,
          y: (canvasSize.h - roomH) / 2,
        });
        return;
      }
      // Duplicate: Cmd+D (Mac) / Ctrl+D (Win/Linux)
      if ((e.metaKey || e.ctrlKey) && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        if (selectedId) handleDuplicate(selectedId);
        return;
      }
      if (e.key === "Escape") {
        setSelectedId(null);
        setContextMenu(null);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        handleDelete();
      } else if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey) {
        handleRotate();
      } else if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey) {
        setObjectPanelOpen((v) => !v);
      } else {
        handleArrowNudge(e);
      }
    },
    [handleDelete, handleRotate, handleArrowNudge, handleDuplicate, undo, redo, selectedId, widthMeters, depthMeters, pxPerMeter, canvasSize],
  );

  const handleDimensionsChange = useCallback(
    (d: RoomDimensions) => {
      // Keep room center fixed on screen when resizing (pxPerMeter is constant)
      const oldCenterScreenX = panOffset.x + (widthMeters / 2) * pxPerMeter * zoom;
      const oldCenterScreenY = panOffset.y + (depthMeters / 2) * pxPerMeter * zoom;

      const newPanX = oldCenterScreenX - (d.widthMeters / 2) * pxPerMeter * zoom;
      const newPanY = oldCenterScreenY - (d.depthMeters / 2) * pxPerMeter * zoom;
      setPanOffset({ x: newPanX, y: newPanY });

      // Shift all objects so they keep their position relative to room center
      const dxM = (d.widthMeters - widthMeters) / 2;
      const dyM = (d.depthMeters - depthMeters) / 2;
      const dxPx = dxM * pxPerMeter;
      const dyPx = dyM * pxPerMeter;

      const patch: Partial<typeof config> = { dimensions: d };

      if (config.tvAnchor) {
        patch.tvAnchor = { ...config.tvAnchor, x: config.tvAnchor.x + dxM, y: config.tvAnchor.y + dyM };
      }
      if (config.furniture.length > 0) {
        patch.furniture = config.furniture.map((f) => ({ ...f, x: f.x + dxM, y: f.y + dyM }));
      }
      if (config.usbStrips.length > 0) {
        patch.usbStrips = config.usbStrips.map((s) => ({ ...s, startX: s.startX + dxM, startY: s.startY + dyM, endX: s.endX + dxM, endY: s.endY + dyM }));
      }
      if (config.hueChannels.length > 0) {
        patch.hueChannels = config.hueChannels.map((ch) => ({ ...ch, x: ch.x + dxM, y: ch.y + dyM }));
      }
      if (config.imageLayers.length > 0) {
        patch.imageLayers = config.imageLayers.map((l) => ({ ...l, offsetX: l.offsetX + dxPx, offsetY: l.offsetY + dyPx }));
      }

      void updateConfig(patch);
    },
    [updateConfig, config, panOffset, widthMeters, depthMeters, zoom],
  );

  // Zone CRUD handlers
  const handleAddZone = useCallback(() => {
    const id = `zone-${crypto.randomUUID()}`;
    const name = t("roomMap.zones.defaultName", { N: String(config.zones.length + 1) });
    const newZone: ZoneDefinition = { id, name, channelIndices: [] };
    void updateConfig({ zones: [...config.zones, newZone] });
    setActiveZoneId(id);
    setObjectPanelOpen(true);
  }, [config.zones, updateConfig, t]);

  const handleDeleteZone = useCallback(
    (zoneId: string) => {
      void updateConfig({ zones: config.zones.filter((z) => z.id !== zoneId) });
      if (activeZoneId === zoneId) setActiveZoneId(null);
    },
    [config.zones, activeZoneId, updateConfig],
  );

  const handleRenameZone = useCallback(
    (zoneId: string, name: string) => {
      void updateConfig({
        zones: config.zones.map((z) => (z.id === zoneId ? { ...z, name } : z)),
      });
    },
    [config.zones, updateConfig],
  );

  // Property bar handlers
  const handleUpdatePosition = useCallback(
    (id: string, x: number, y: number) => {
      if (id === "tv" && config.tvAnchor) {
        void updateConfig({ tvAnchor: { ...config.tvAnchor, x, y } });
      } else if (id.startsWith("furniture-")) {
        const fId = id.replace("furniture-", "");
        void updateConfig({ furniture: config.furniture.map((f) => (f.id === fId ? { ...f, x, y } : f)) });
      } else if (id.startsWith("usb-")) {
        const sId = id.replace("usb-", "");
        const src = config.usbStrips.find((s) => s.stripId === sId);
        if (!src) return;
        const dx = x - src.startX;
        const dy = y - src.startY;
        void updateConfig({ usbStrips: config.usbStrips.map((s) => (s.stripId === sId ? { ...s, startX: x, startY: y, endX: s.endX + dx, endY: s.endY + dy } : s)) });
      } else if (id.startsWith("hue-")) {
        const idx = parseInt(id.replace("hue-", ""), 10);
        void updateConfig({ hueChannels: config.hueChannels.map((ch) => (ch.channelIndex === idx ? { ...ch, x, y } : ch)) });
      } else if (id.startsWith("img-")) {
        const imgId = id.replace("img-", "");
        void updateConfig({ imageLayers: config.imageLayers.map((l) => (l.id === imgId ? { ...l, offsetX: x, offsetY: y } : l)) });
      }
    },
    [config, updateConfig],
  );

  const handleUpdateSize = useCallback(
    (id: string, w: number, h: number) => {
      if (id === "tv" && config.tvAnchor) {
        void updateConfig({ tvAnchor: { ...config.tvAnchor, width: w, height: h } });
      } else if (id.startsWith("furniture-")) {
        const fId = id.replace("furniture-", "");
        void updateConfig({ furniture: config.furniture.map((f) => (f.id === fId ? { ...f, width: w, height: h } : f)) });
      }
    },
    [config, updateConfig],
  );

  const handleUpdateRotation = useCallback(
    (id: string, rotation: number) => {
      if (id.startsWith("furniture-")) {
        const fId = id.replace("furniture-", "");
        void updateConfig({ furniture: config.furniture.map((f) => (f.id === fId ? { ...f, rotation } : f)) });
      }
    },
    [config.furniture, updateConfig],
  );

  const handleUpdateImageOpacity = useCallback(
    (imageId: string, opacity: number) => {
      void updateConfig({ imageLayers: config.imageLayers.map((l) => (l.id === imageId ? { ...l, opacity } : l)) });
    },
    [config.imageLayers, updateConfig],
  );

  const handleUpdateImageScale = useCallback(
    (imageId: string, sx: number, sy: number) => {
      void updateConfig({ imageLayers: config.imageLayers.map((l) => (l.id === imageId ? { ...l, scaleX: sx, scaleY: sy } : l)) });
    },
    [config.imageLayers, updateConfig],
  );

  const handleUpdateImageAspectLock = useCallback(
    (imageId: string, locked: boolean) => {
      // Just toggle the flag — keep current scaleX/scaleY as-is
      void updateConfig({ imageLayers: config.imageLayers.map((l) => (l.id === imageId ? { ...l, aspectLocked: locked } : l)) });
    },
    [config.imageLayers, updateConfig],
  );

  const handleResetImageScale = useCallback(
    (imageId: string) => {
      const layer = config.imageLayers.find((l) => l.id === imageId);
      if (!layer) return;
      // Reset aspect ratio only — unify scaleY to scaleX, keep current size
      const s = layer.scaleX ?? layer.scale;
      void updateConfig({ imageLayers: config.imageLayers.map((l) => (l.id === imageId ? { ...l, scaleX: s, scaleY: s } : l)) });
    },
    [config.imageLayers, updateConfig],
  );

  const handleSelectZone = useCallback((zoneId: string | null) => {
    setActiveZoneId(zoneId);
  }, []);

  const handleRenameFurniture = useCallback(
    (id: string, label: string) => {
      void updateConfig({
        furniture: config.furniture.map((f) => (f.id === id ? { ...f, label } : f)),
      });
    },
    [config.furniture, updateConfig],
  );

  const handleRenameImage = useCallback(
    (imageId: string, label: string) => {
      void updateConfig({
        imageLayers: config.imageLayers.map((l) => (l.id === imageId ? { ...l, label } : l)),
      });
    },
    [config.imageLayers, updateConfig],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (!selectedId) return;
      setContextMenu({ x: e.clientX, y: e.clientY, targetId: selectedId });
    },
    [selectedId],
  );

  const getContextMenuActions = useCallback((): ContextMenuAction[] => {
    if (!contextMenu) return [];
    const id = contextMenu.targetId;
    const isMac = navigator.platform.includes("Mac");
    const actions: ContextMenuAction[] = [];

    const canDuplicate = id.startsWith("furniture-") || id.startsWith("usb-");
    if (canDuplicate) {
      actions.push({
        label: t("roomMap.contextMenu.duplicate"),
        shortcut: isMac ? "\u2318D" : "Ctrl+D",
        onClick: () => handleDuplicate(id),
      });
    }

    const isFurniture = id.startsWith("furniture-");
    if (isFurniture) {
      const furnitureId = id.replace("furniture-", "");
      actions.push({
        label: t("roomMap.contextMenu.rename"),
        onClick: () => {
          const current = config.furniture.find((f) => f.id === furnitureId);
          setRenameTarget({ id: furnitureId, currentLabel: current?.label ?? "" });
        },
      });
      actions.push({
        label: t("roomMap.contextMenu.rotate"),
        shortcut: "R",
        onClick: () => {
          setSelectedId(id);
          handleRotate();
        },
      });
    }

    const isImage = id.startsWith("img-");
    if (isImage) {
      const imageId = id.replace("img-", "");
      const current = config.imageLayers.find((l) => l.id === imageId);
      actions.push({
        label: t("roomMap.contextMenu.rename"),
        onClick: () => {
          setRenameTarget({ id: `img-${imageId}`, currentLabel: current?.label ?? "" });
        },
      });
    }

    actions.push({
      label: t("roomMap.contextMenu.delete"),
      shortcut: isMac ? "\u232B" : "Del",
      danger: true,
      onClick: () => deleteById(id),
    });

    return actions;
  }, [contextMenu, t, handleDuplicate, handleRotate, deleteById, config.furniture, config.imageLayers, handleRenameFurniture]);

  const handleChannelZoneToggle = useCallback(
    (channelIndex: number) => {
      if (!activeZoneId) return;
      const zone = config.zones.find((z) => z.id === activeZoneId);
      if (!zone) return;
      const hasChannel = zone.channelIndices.includes(channelIndex);
      const updatedIndices = hasChannel
        ? zone.channelIndices.filter((i) => i !== channelIndex)
        : [...zone.channelIndices, channelIndex];
      void updateConfig({
        zones: config.zones.map((z) =>
          z.id === activeZoneId ? { ...z, channelIndices: updatedIndices } : z,
        ),
      });
    },
    [activeZoneId, config.zones, updateConfig],
  );

  // Derived zone assign values
  const zoneAssignMode = activeZoneId !== null;
  const activeZone = config.zones.find((z) => z.id === activeZoneId);
  const activeZoneIndex = config.zones.findIndex((z) => z.id === activeZoneId);
  const activeZoneColor = activeZoneIndex >= 0 ? getZoneColorHex(activeZoneIndex) : null;
  const assignedChannels = new Set(config.zones.flatMap((z) => z.channelIndices));
  const activeZoneChannels = new Set(activeZone?.channelIndices ?? []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-sm text-slate-400 dark:text-zinc-500">Loading...</span>
      </div>
    );
  }

  // Show template selector for empty maps with no edit history
  if (isEmpty && !canUndo) {
    return <TemplateSelector onSelect={(tmpl) => void replaceConfig(tmpl)} />;
  }

  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      tabIndex={0}
      style={{ outline: "none" }}
    >
      <RoomMapToolbar
        hasTv={hasTv}
        hasUsb={hasUsb}
        derivePreviewActive={derivePreviewActive}
        zoneCount={config.zones.length}
        onDeriveZones={handleDeriveZones}
        onAddZone={handleAddZone}
        settingsOpen={settingsOpen}
        onToggleSettings={() => setSettingsOpen((v) => !v)}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={() => void undo()}
        onRedo={() => void redo()}
      />
      <div className="flex flex-1 min-h-0">
        <div
          className="relative flex-1"
          ref={canvasContainerRef}
          onMouseMove={(e) => {
            const rect = canvasContainerRef.current?.getBoundingClientRect();
            if (!rect) return;
            const mx = (e.clientX - rect.left - panOffset.x) / (pxPerMeter * zoom);
            const my = (e.clientY - rect.top - panOffset.y) / (pxPerMeter * zoom);
            // Center-based: 0,0 = room center
            setMouseCoord({ x: mx - widthMeters / 2, y: my - depthMeters / 2 });
          }}
          onMouseLeave={() => setMouseCoord(null)}
        >
          {/* Floating tool chips — top-left of canvas */}
          <LeftToolbar
            hasTv={hasTv}
            onAddTv={handleAddTv}
            onAddFurniture={handleAddFurniture}
            onAddUsb={handleAddUsb}
            onAddHue={handleAddHue}
            onAddImage={() => void handleAddImage()}
          />

          {settingsOpen && (
            <RoomMapSettingsPopover
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
              dimensions={config.dimensions}
              showGrid={showGrid}
              onDimensionsChange={handleDimensionsChange}
              gridStrokeWidth={gridStrokeWidth}
              onGridToggle={setShowGrid}
              onGridStrokeWidthChange={setGridStrokeWidth}
              onReset={() => void resetConfig()}
            />
          )}
          <RoomMapCanvas
            config={config}
            pxPerMeter={pxPerMeter}
            showGrid={showGrid}
            gridStrokeWidth={gridStrokeWidth}
            selectedId={selectedId}
            onCanvasClick={() => setSelectedId(null)}
            onImageLayerTransformChange={(id, ox, oy, s, sx, sy) => {
              void updateConfig({
                imageLayers: config.imageLayers.map((l) =>
                  l.id === id ? { ...l, offsetX: ox, offsetY: oy, scale: s, ...(sx != null ? { scaleX: sx } : {}), ...(sy != null ? { scaleY: sy } : {}) } : l,
                ),
              });
            }}
            onImageLayerSelect={(id) => setSelectedId(`img-${id}`)}
            zoom={zoom}
            panOffset={panOffset}
            onZoomChange={setZoom}
            onPanChange={setPanOffset}
            panMode={spaceHeld}
          >
            {isEmpty && <RoomMapEmptyHint />}

            {/* Origin crosshair marker — always centered, extends to edges */}
            <OriginMarker
              widthM={widthMeters}
              depthM={depthMeters}
              pxPerMeter={pxPerMeter}
            />

            {/* USB strip SVG overlay + handles */}
            {config.usbStrips.map((strip) => (
              <UsbStripObject
                key={strip.stripId}
                placement={strip}
                pxPerMeter={pxPerMeter}
                selected={selectedId === `usb-${strip.stripId}`}
                zoom={zoom}
                panMode={spaceHeld}
                onSelect={(id) => setSelectedId(`usb-${id}`)}
                onChange={(updated) => {
                  const next = config.usbStrips.map((s) =>
                    s.stripId === updated.stripId ? updated : s,
                  );
                  void updateConfig({ usbStrips: next });
                }}
              />
            ))}

            {/* Furniture objects */}
            {config.furniture.map((f) => (
              <FurnitureObject
                key={f.id}
                placement={f}
                pxPerMeter={pxPerMeter}
                selected={selectedId === `furniture-${f.id}`}
                gridStepPx={gridStepPx}
                snapEnabled={showGrid}
                zoom={zoom}
                panMode={spaceHeld}
                onSelect={(id) => setSelectedId(`furniture-${id}`)}
                onChange={(updated) => {
                  const next = config.furniture.map((item) =>
                    item.id === updated.id ? updated : item,
                  );
                  void updateConfig({ furniture: next });
                }}
                onSnapDragMove={snapDragMove}
                onSnapDragEnd={snapDragEnd}
              />
            ))}

            {/* TV anchor */}
            {config.tvAnchor && (
              <TvAnchorObject
                placement={config.tvAnchor}
                pxPerMeter={pxPerMeter}
                selected={selectedId === "tv"}
                gridStepPx={gridStepPx}
                snapEnabled={showGrid}
                zoom={zoom}
                panMode={spaceHeld}
                onSelect={() => setSelectedId("tv")}
                onChange={(updated) => void updateConfig({ tvAnchor: updated })}
                onSnapDragMove={snapDragMove}
                onSnapDragEnd={snapDragEnd}
              />
            )}

            {/* Hue channel dots */}
            {config.hueChannels.length > 0 && (
              <HueChannelOverlay
                channels={config.hueChannels}
                pxPerMeter={pxPerMeter}
                roomWidthM={widthMeters}
                roomDepthM={depthMeters}
                zoom={zoom}
                selectedId={selectedId}
                onSelect={(idx) => setSelectedId(`hue-${idx}`)}
                onChange={(updated) => {
                  const next = config.hueChannels.map((ch) =>
                    ch.channelIndex === updated.channelIndex ? updated : ch,
                  );
                  void updateConfig({ hueChannels: next });
                }}
                zoneAssignMode={zoneAssignMode}
                activeZoneColor={activeZoneColor}
                assignedChannels={assignedChannels}
                activeZoneChannels={activeZoneChannels}
                onChannelZoneToggle={handleChannelZoneToggle}
                panMode={spaceHeld}
              />
            )}

            {/* Zone derive preview overlay */}
            {derivePreview && config.tvAnchor && (
              <ZoneDeriveOverlay
                result={derivePreview}
                tv={config.tvAnchor}
                pxPerMeter={pxPerMeter}
                onConfirm={handleDeriveConfirm}
                onDiscard={handleDeriveDiscard}
              />
            )}

            {/* Snap alignment guides */}
            <SnapGuideOverlay
              guides={snapGuides}
              pxPerMeter={pxPerMeter}
              canvasWidth={canvasSize.w}
              canvasHeight={canvasSize.h}
            />

          </RoomMapCanvas>

          {/* Mouse coordinate display — fixed to bottom-right of canvas container */}
          {mouseCoord && (
            <div className="absolute bottom-1 right-1 pointer-events-none z-50 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-mono text-white/80 tabular-nums">
              x: {mouseCoord.x >= 0 ? "+" : ""}{mouseCoord.x.toFixed(1)}m, y: {mouseCoord.y >= 0 ? "+" : ""}{mouseCoord.y.toFixed(1)}m
            </div>
          )}
        </div>

        {/* Object list panel — right sidebar, collapsible with F key */}
        {objectPanelOpen && (
          <ObjectListPanel
            config={config}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDelete={deleteById}
            onRenameFurniture={handleRenameFurniture}
            onToggleLock={(id) => {
              if (id === "tv" && config.tvAnchor) {
                void updateConfig({ tvAnchor: { ...config.tvAnchor, locked: !config.tvAnchor.locked } });
              } else if (id.startsWith("furniture-")) {
                const fId = id.replace("furniture-", "");
                void updateConfig({ furniture: config.furniture.map((f) => (f.id === fId ? { ...f, locked: !f.locked } : f)) });
              } else if (id.startsWith("usb-")) {
                const sId = id.replace("usb-", "");
                void updateConfig({ usbStrips: config.usbStrips.map((s) => (s.stripId === sId ? { ...s, locked: !s.locked } : s)) });
              } else if (id.startsWith("hue-")) {
                const idx = parseInt(id.replace("hue-", ""), 10);
                void updateConfig({ hueChannels: config.hueChannels.map((ch) => (ch.channelIndex === idx ? { ...ch, locked: !ch.locked } : ch)) });
              } else if (id.startsWith("img-")) {
                const imgId = id.replace("img-", "");
                void updateConfig({ imageLayers: config.imageLayers.map((l) => (l.id === imgId ? { ...l, locked: !l.locked } : l)) });
              }
            }}
            zones={config.zones}
            activeZoneId={activeZoneId}
            onSelectZone={handleSelectZone}
            onAddZone={handleAddZone}
            onDeleteZone={handleDeleteZone}
            onRenameZone={handleRenameZone}
          />
        )}
      </div>

      {/* Property bar */}
      <PropertyBar
        config={config}
        selectedId={selectedId}
        onUpdatePosition={handleUpdatePosition}
        onUpdateSize={handleUpdateSize}
        onUpdateRotation={handleUpdateRotation}
        onUpdateImageOpacity={handleUpdateImageOpacity}
        onUpdateImageScale={handleUpdateImageScale}
        onUpdateImageAspectLock={handleUpdateImageAspectLock}
        onResetImageScale={handleResetImageScale}
      />

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          actions={getContextMenuActions()}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Rename dialog */}
      {renameTarget && (
        <RenameDialog
          currentLabel={renameTarget.currentLabel}
          promptText={t("roomMap.contextMenu.renamePrompt")}
          onConfirm={(newName) => {
            if (renameTarget.id.startsWith("img-")) {
              handleRenameImage(renameTarget.id.replace("img-", ""), newName);
            } else {
              handleRenameFurniture(renameTarget.id, newName);
            }
            setRenameTarget(null);
          }}
          onCancel={() => setRenameTarget(null)}
        />
      )}

      {error && (
        <div className="px-3 py-1.5 text-[11px] text-red-500">
          {t("roomMap.persistError")}
        </div>
      )}
    </div>
  );
}

function RenameDialog({
  currentLabel,
  promptText,
  onConfirm,
  onCancel,
}: {
  currentLabel: string;
  promptText: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(currentLabel);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed) onConfirm(trimmed);
    else onCancel();
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30" onClick={onCancel}>
      <div
        className="rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl p-4 w-64"
        onClick={(e) => e.stopPropagation()}
      >
        <label className="block text-[11px] font-semibold text-slate-700 dark:text-zinc-300 mb-2">
          {promptText}
        </label>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape") onCancel();
          }}
          className="w-full rounded border border-slate-200 dark:border-zinc-700 bg-transparent px-2 py-1 text-sm text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
          autoFocus
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            className="px-2.5 py-1 text-[11px] rounded text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-800"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="px-2.5 py-1 text-[11px] rounded bg-cyan-500 text-white hover:bg-cyan-600"
            onClick={handleSubmit}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
