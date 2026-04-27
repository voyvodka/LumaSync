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
import { RoomDockPanel } from "./room-map/RoomDockPanel";
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
  HueZone,
  RoomDimensions,
  ZoneDefinition,
} from "../../../shared/contracts/roomMap";
import type { LedSegmentCounts } from "../../calibration/model/contracts";
import React from "react";
import { shellStore } from "../../persistence/shellStore";
import { HUE_ZONE_COMMANDS } from "../../../shared/contracts/hue";

interface RoomMapEditorProps {
  onZoneCountsConfirmed?: (counts: LedSegmentCounts) => void;
  /**
   * Wave 4-B (B1) — invoked when the dock state strip's CTA prompts the
   * user to finish Hue onboarding (pair bridge or pick an entertainment
   * area). The Settings shell wires this to `setActiveSection(DEVICES)`
   * so the user is dropped into the right place to recover.
   */
  onNavigateToDevices?: () => void;
}

// CSS custom property references matching ZONE_COLORS Tailwind classes
// (for inline boxShadow ring). Hex values are defined in src/styles.css
// under --lm-zone-{1..6} so JS and CSS share a single source of truth.
const ZONE_COLOR_HEX = [
  "var(--lm-zone-1)",
  "var(--lm-zone-2)",
  "var(--lm-zone-3)",
  "var(--lm-zone-4)",
  "var(--lm-zone-5)",
  "var(--lm-zone-6)",
];

const MouseCoordinateDisplay = React.memo(function MouseCoordinateDisplay({
  canvasContainerRef,
  panOffset,
  pxPerMeter,
  zoom,
  widthMeters,
  depthMeters,
}: {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  panOffset: { x: number; y: number };
  pxPerMeter: number;
  zoom: number;
  widthMeters: number;
  depthMeters: number;
}) {
  const displayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = canvasContainerRef.current;
    if (!el) return;

    let ticking = false;
    let latestEvent: MouseEvent | null = null;

    const updateCoord = () => {
      if (!latestEvent || !displayRef.current) return;
      const rect = el.getBoundingClientRect();
      const mx = (latestEvent.clientX - rect.left - panOffset.x) / (pxPerMeter * zoom);
      const my = (latestEvent.clientY - rect.top - panOffset.y) / (pxPerMeter * zoom);

      const worldX = mx - widthMeters / 2;
      const worldY = my - depthMeters / 2;

      displayRef.current.textContent = `x: ${worldX >= 0 ? "+" : ""}${worldX.toFixed(1)}m, y: ${worldY >= 0 ? "+" : ""}${worldY.toFixed(1)}m`;
      displayRef.current.style.display = "block";

      ticking = false;
    };

    const handleMouseMove = (e: MouseEvent) => {
      latestEvent = e;
      if (!ticking) {
        requestAnimationFrame(updateCoord);
        ticking = true;
      }
    };

    const handleMouseLeave = () => {
      latestEvent = null;
      if (displayRef.current) {
        displayRef.current.style.display = "none";
      }
    };

    el.addEventListener("mousemove", handleMouseMove);
    el.addEventListener("mouseleave", handleMouseLeave);

    return () => {
      el.removeEventListener("mousemove", handleMouseMove);
      el.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [canvasContainerRef, panOffset, pxPerMeter, zoom, widthMeters, depthMeters]);

  return (
    <div
      ref={displayRef}
      className="absolute bottom-1 right-1 pointer-events-none z-50 rounded bg-black/60 px-1.5 py-0.5 text-[9px] [font-family:var(--lm-mono)] text-white/80 tabular-nums"
      style={{ display: "none" }}
    />
  );
});

function getZoneColorHex(index: number): string {
  return ZONE_COLOR_HEX[index % ZONE_COLOR_HEX.length];
}


export function RoomMapEditor({ onZoneCountsConfirmed, onNavigateToDevices }: RoomMapEditorProps = {}) {
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
  const [activeHueZoneId, setActiveHueZoneId] = useState<string | null>(null);
  /** Cached active entertainment area id from shellStore — used when authoring Hue zones. */
  const [hueAreaId, setHueAreaId] = useState<string | null>(null);
  const [objectPanelOpen, setObjectPanelOpen] = useState(true);

  // Wave 4-B (B1) — track Hue bridge state alongside the area id so the
  // dock can render a state-aware header (no bridge / no area / ready)
  // without mounting the full onboarding state machine. We treat
  // `hueAppKey` (legacy plaintext) OR `credentialStorageBackend === keychain`
  // as "configured"; reachability beyond that requires `useHueOnboarding`
  // and is intentionally out of scope for the editor.
  const [hueBridgeConfigured, setHueBridgeConfigured] = useState(false);
  // Load the persisted last-selected entertainment area id once. We do not
  // mount useHueOnboarding here to keep the editor decoupled from the
  // onboarding state machine; the area id alone is enough to author zones.
  useEffect(() => {
    let cancelled = false;
    void shellStore.load().then((state) => {
      if (cancelled) return;
      setHueAreaId(state.lastHueAreaId ?? null);
      const hasKeychain = state.credentialStorageBackend === "keychain";
      const hasLegacyKey = !!state.hueAppKey;
      const hasBridge = !!state.lastHueBridge;
      setHueBridgeConfigured(hasBridge && (hasKeychain || hasLegacyKey));
    });
    return () => { cancelled = true; };
  }, []);

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

  // ---------------------------------------------------------------------------
  // Hue Zone CRUD handlers (v1.5 W1-A5)
  // ---------------------------------------------------------------------------
  // Each handler optimistically mutates config.hueZones then fires the
  // matching Tauri command. The local config is the persistence source of
  // truth; the Tauri side mirrors the change for the runtime sampler. If
  // the invoke fails we surface the error via console (silent-catch ban)
  // but keep the local edit so the UI does not flicker — the next save
  // round will reconcile.

  const hueZones = config.hueZones ?? [];

  const handleAddHueZone = useCallback(() => {
    if (!hueAreaId) return;
    const id = `hue-zone-${crypto.randomUUID()}`;
    const name = t("roomMap.hueZones.defaultName", { N: String(hueZones.length + 1) });
    const palette = ["--lm-zone-1", "--lm-zone-2", "--lm-zone-3", "--lm-zone-4", "--lm-zone-5", "--lm-zone-6"];
    const colorVar = `var(${palette[hueZones.length % palette.length]})`;
    const newZone: HueZone = {
      id,
      name,
      entertainmentAreaId: hueAreaId,
      centerX: 0,
      centerY: 0,
      centerZ: 0,
      scaleX: 0.5,
      scaleY: 0.5,
      scaleZ: 0.5,
      channelIndices: [],
      borderColor: colorVar,
      // Bug #51 — centerColor deprecated; do not author new values.
    };
    void updateConfig({ hueZones: [...hueZones, newZone] });
    setActiveHueZoneId(id);
    setObjectPanelOpen(true);

    // Mirror to backend; never throw — silent-catch ban → log only.
    void invoke(HUE_ZONE_COMMANDS.CREATE_ZONE, {
      request: { zone: newZone, existingZones: hueZones },
    }).catch((e) => {
      console.error("[LumaSync] create_hue_zone failed", e);
    });
  }, [hueAreaId, hueZones, updateConfig, t]);

  const handleDeleteHueZone = useCallback(
    (zoneId: string) => {
      const nextZones = hueZones.filter((z) => z.id !== zoneId);
      // Detach channels that pointed at this zone — they fall back to legacy absolute placement.
      const nextChannels = config.hueChannels.map((ch) =>
        ch.zoneId === zoneId
          ? { ...ch, zoneId: undefined, zoneRelativePosition: undefined }
          : ch,
      );
      void updateConfig({ hueZones: nextZones, hueChannels: nextChannels });
      if (activeHueZoneId === zoneId) setActiveHueZoneId(null);

      void invoke(HUE_ZONE_COMMANDS.DELETE_ZONE, {
        request: { zoneId, existingZones: hueZones, channels: config.hueChannels },
      }).catch((e) => {
        console.error("[LumaSync] delete_hue_zone failed", e);
      });
    },
    [hueZones, config.hueChannels, activeHueZoneId, updateConfig],
  );

  const handleRenameHueZone = useCallback(
    (zoneId: string, name: string) => {
      const next = hueZones.map((z) => (z.id === zoneId ? { ...z, name } : z));
      void updateConfig({ hueZones: next });
      const renamed = next.find((z) => z.id === zoneId);
      if (renamed) {
        void invoke(HUE_ZONE_COMMANDS.UPDATE_ZONE, {
          request: { zone: renamed, existingZones: next },
        }).catch((e) => {
          console.error("[LumaSync] update_hue_zone (rename) failed", e);
        });
      }
    },
    [hueZones, updateConfig],
  );

  const handleSelectHueZone = useCallback((zoneId: string | null) => {
    setActiveHueZoneId(zoneId);
  }, []);

  // ── Wave 4-B (B2/B3) — Channel ↔ zone assignment + cross-zone transfer
  // ─────────────────────────────────────────────────────────────────────
  // Single optimistic handler the dock uses for every channel→zone path:
  //   - drag-drop onto a zone header
  //   - drag-drop onto the "Unassigned" bucket
  //   - context "Move to → <zone>" popover
  // The local config update keeps three derived shapes in sync:
  //   1. `hueChannels[i].zoneId` — primary join key
  //   2. `hueChannels[i].zoneRelativePosition` — defaults to (0,0,0) so the
  //      dot lands on the zone center; user can drag to refine.
  //   3. `hueZones[*].channelIndices` — denormalized list mirrored for
  //      runtime sampler; we keep it consistent so frame-builder and
  //      zone-cap validators do not desync.
  // The Tauri mirror (`assign_channel_to_zone`) follows the same
  // silent-catch-banned pattern: we log on failure but keep the local
  // edit so the UI does not flicker.
  const handleAssignChannelToZone = useCallback(
    (channelIndex: number, targetZoneId: string | null) => {
      const channel = config.hueChannels.find((c) => c.channelIndex === channelIndex);
      if (!channel) return;
      // No-op if already in the target bucket — avoids spurious invokes.
      const currentZoneId = channel.zoneId ?? null;
      if (currentZoneId === targetZoneId) return;

      // Resolve the entertainment area id we will send to the backend.
      // Prefer the target zone's value when attaching; on detach, keep the
      // channel's last known area (or the persisted `hueAreaId` fallback).
      const targetZone = targetZoneId
        ? hueZones.find((z) => z.id === targetZoneId)
        : null;
      const entertainmentAreaId =
        targetZone?.entertainmentAreaId ?? hueAreaId ?? "";

      // Default zone-relative position lands on the zone center so the
      // dot is visible inside the dashed bounds; the user can drag it
      // afterwards to refine the placement.
      const nextChannels = config.hueChannels.map((c) =>
        c.channelIndex === channelIndex
          ? targetZoneId
            ? {
                ...c,
                zoneId: targetZoneId,
                zoneRelativePosition: { x: 0, y: 0, z: 0 },
              }
            : { ...c, zoneId: undefined, zoneRelativePosition: undefined }
          : c,
      );
      // Keep `hueZones[*].channelIndices` in sync — remove from old zone,
      // add to new zone (idempotent).
      const nextZones = hueZones.map((z) => {
        const without = z.channelIndices.filter((i) => i !== channelIndex);
        if (z.id === targetZoneId) {
          return { ...z, channelIndices: [...without, channelIndex] };
        }
        return { ...z, channelIndices: without };
      });
      void updateConfig({ hueChannels: nextChannels, hueZones: nextZones });

      void invoke(HUE_ZONE_COMMANDS.ASSIGN_CHANNEL_TO_ZONE, {
        request: {
          channelIndex,
          zoneId: targetZoneId,
          zoneRelativePosition: targetZoneId ? { x: 0, y: 0, z: 0 } : null,
          entertainmentAreaId,
          existingZones: nextZones,
          channels: nextChannels,
        },
      }).catch((e) => {
        console.error("[LumaSync] assign_channel_to_zone failed", e);
      });
    },
    [config.hueChannels, hueZones, hueAreaId, updateConfig],
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

  // ── v1.5 W1-A6: derive active Hue zone ──────────────────────────────
  const activeHueZone = activeHueZoneId
    ? hueZones.find((z) => z.id === activeHueZoneId) ?? null
    : null;

  const handleHueZoneCenterChange = useCallback(
    (zoneId: string, centerX: number, centerY: number) => {
      const next = (config.hueZones ?? []).map((z) =>
        z.id === zoneId ? { ...z, centerX, centerY } : z,
      );
      void updateConfig({ hueZones: next });
      const updated = next.find((z) => z.id === zoneId);
      if (updated) {
        void invoke(HUE_ZONE_COMMANDS.UPDATE_ZONE, {
          request: { zone: updated, existingZones: next },
        }).catch((e) => {
          console.error("[LumaSync] update_hue_zone (center) failed", e);
        });
      }
    },
    [config.hueZones, updateConfig],
  );

  // ── v1.5 W1-A8: Generic Hue zone patch handler ───────────────────────
  // Used by HueZonePropertiesPanel to update borderColor / centerColor
  // (and reserved for future zone-level fields). Same optimistic pattern
  // as the create / delete / center handlers — local config first, then
  // mirror via update_hue_zone with silent-catch logging.
  const handleHueZoneUpdate = useCallback(
    (zoneId: string, patch: Partial<HueZone>) => {
      const next = (config.hueZones ?? []).map((z) =>
        z.id === zoneId ? { ...z, ...patch } : z,
      );
      void updateConfig({ hueZones: next });
      const updated = next.find((z) => z.id === zoneId);
      if (updated) {
        void invoke(HUE_ZONE_COMMANDS.UPDATE_ZONE, {
          request: { zone: updated, existingZones: next },
        }).catch((e) => {
          console.error("[LumaSync] update_hue_zone (props) failed", e);
        });
      }
    },
    [config.hueZones, updateConfig],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-sm text-zinc-500">Loading...</span>
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

            {/* Hue channel dots + zone bounds — bug #53: bounds box must render even when no channels exist yet so the user can author a zone before the area is paired. */}
            {(config.hueChannels.length > 0 || activeHueZone !== null) && (
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
                activeHueZone={activeHueZone}
                onHueZoneCenterChange={handleHueZoneCenterChange}
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
          <MouseCoordinateDisplay
            canvasContainerRef={canvasContainerRef}
            panOffset={panOffset}
            pxPerMeter={pxPerMeter}
            zoom={zoom}
            widthMeters={widthMeters}
            depthMeters={depthMeters}
          />
        </div>

        {/* Right dock — consolidated tabbed Objects / Zones / Hue Zones / Properties */}
        {objectPanelOpen && (
          <RoomDockPanel
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
            hueZones={hueZones}
            activeHueZoneId={activeHueZoneId}
            onSelectHueZone={handleSelectHueZone}
            onAddHueZone={handleAddHueZone}
            onDeleteHueZone={handleDeleteHueZone}
            onRenameHueZone={handleRenameHueZone}
            onUpdateHueZone={handleHueZoneUpdate}
            addHueZoneDisabled={!hueAreaId}
            addHueZoneDisabledTooltip={t("roomMap.hueZones.addDisabledTooltip")}
            hueBridgeConfigured={hueBridgeConfigured}
            hueAreaId={hueAreaId}
            onAssignChannelToZone={handleAssignChannelToZone}
            onNavigateToDevices={onNavigateToDevices}
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
  const { t } = useTranslation("common");
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
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: "rgba(7, 8, 10, 0.55)" }}
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-dialog-label"
    >
      <div
        className="lm-settings-group p-4 w-64 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <label
          id="rename-dialog-label"
          className="block text-[11px] font-semibold mb-2"
          style={{ color: "var(--lm-ink)", fontFamily: "var(--lm-mono)", letterSpacing: "0.04em" }}
        >
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
          className="w-full rounded px-2 py-1.5 text-sm focus:outline-none"
          style={{
            background: "var(--lm-panel-2)",
            border: "1px solid var(--lm-line-2)",
            color: "var(--lm-ink)",
            boxShadow: "var(--lm-focus-ring-soft)",
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "rgba(255, 176, 32, 0.45)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "var(--lm-line-2)";
          }}
          autoFocus
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="rounded text-[11px]"
            style={{
              minHeight: 28,
              padding: "4px 10px",
              color: "var(--lm-ink-dim)",
              background: "transparent",
              fontFamily: "var(--lm-mono)",
              letterSpacing: "0.04em",
            }}
            onClick={onCancel}
          >
            {t("roomMap.contextMenu.renameCancel")}
          </button>
          <button
            type="button"
            className="rounded text-[11px] font-semibold"
            style={{
              minHeight: 28,
              padding: "4px 12px",
              background: "var(--lm-amber)",
              color: "var(--lm-bg)",
              fontFamily: "var(--lm-mono)",
              letterSpacing: "0.04em",
            }}
            onClick={handleSubmit}
          >
            {t("roomMap.contextMenu.renameOk")}
          </button>
        </div>
      </div>
    </div>
  );
}
