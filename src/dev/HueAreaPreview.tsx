/**
 * DEV ONLY — Hue area step UI preview with mock data.
 * Import this in App.tsx temporarily to preview without a real Hue connection.
 * Remove when done.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { HueChannelMapPanel, MiniSpatialPreview } from "../features/settings/sections/HueChannelMapPanel";
import type { HueAreaChannelInfo } from "../features/device/hueOnboardingApi";

/** 10 channels spread around the TV — varied positions for thorough spatial testing. */
const MOCK_CHANNELS: HueAreaChannelInfo[] = [
  // Left wall
  { index: 0, positionX: -0.9,  positionY:  0.3,  lightCount: 3, autoRegion: "left" },
  { index: 1, positionX: -0.85, positionY: -0.3,  lightCount: 2, autoRegion: "left" },
  // Right wall
  { index: 2, positionX:  0.9,  positionY:  0.35, lightCount: 3, autoRegion: "right" },
  { index: 3, positionX:  0.85, positionY: -0.25, lightCount: 2, autoRegion: "right" },
  // Top / ceiling
  { index: 4, positionX: -0.3,  positionY:  0.85, lightCount: 2, autoRegion: "top" },
  { index: 5, positionX:  0.3,  positionY:  0.9,  lightCount: 2, autoRegion: "top" },
  // Bottom / floor
  { index: 6, positionX: -0.25, positionY: -0.85, lightCount: 1, autoRegion: "bottom" },
  { index: 7, positionX:  0.25, positionY: -0.9,  lightCount: 1, autoRegion: "bottom" },
  // Center / behind TV
  { index: 8, positionX:  0.0,  positionY:  0.0,  lightCount: 1, autoRegion: "center" },
  { index: 9, positionX:  0.15, positionY:  0.15, lightCount: 1, autoRegion: "center" },
];

/** Mock channel positions for mini-preview (subset per area) */
const MOCK_AREA_CHANNELS: Record<string, { positionX: number; positionY: number }[]> = {
  "area-1": MOCK_CHANNELS.map((ch) => ({ positionX: ch.positionX, positionY: ch.positionY })),
  "area-2": [
    { positionX: -0.5, positionY: 0.6 },
    { positionX: 0.0,  positionY: 0.6 },
    { positionX: 0.5,  positionY: 0.6 },
  ],
  "area-3": [
    { positionX: -0.7, positionY: 0.0 },
    { positionX: 0.7,  positionY: 0.0 },
    { positionX: 0.0,  positionY: 0.7 },
    { positionX: 0.0,  positionY: -0.7 },
  ],
};

interface MockArea {
  id: string;
  name: string;
  channelCount: number;
  readiness: { ready: boolean } | undefined;
  activeStreamer?: boolean;
}

interface MockAreaGroup {
  roomName: string;
  areas: MockArea[];
}

const MOCK_AREA_GROUPS: MockAreaGroup[] = [
  {
    roomName: "Living Room",
    areas: [
      { id: "area-1", name: "TV Area", channelCount: 10, readiness: { ready: true }, activeStreamer: false },
      { id: "area-2", name: "Ceiling Gradient", channelCount: 3, readiness: { ready: false }, activeStreamer: true },
    ],
  },
  {
    roomName: "Bedroom",
    areas: [
      { id: "area-3", name: "Monitor Sync", channelCount: 4, readiness: undefined },
    ],
  },
];

export function HueAreaPreview() {
  const { t } = useTranslation("common");
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<number, string>>({});

  const selectedArea: MockArea | undefined = MOCK_AREA_GROUPS
    .flatMap((g) => g.areas)
    .find((a) => a.id === selectedAreaId);

  return (
    <div className="min-h-screen bg-zinc-950 p-8">
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
          DEV PREVIEW — Hue Area Step
        </h1>

        {/* Area list */}
        <div className="space-y-4">
          {MOCK_AREA_GROUPS.map((group) => (
            <div key={group.roomName}>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                {group.roomName}
              </p>
              <ul className="space-y-2">
                {group.areas.map((area) => {
                  const active = selectedAreaId === area.id;
                  const readinessLabel = (area.readiness?.ready
                    ? t("device.hue.readiness.ready")
                    : area.readiness
                      ? t("device.hue.readiness.notReady")
                      : t("device.hue.readiness.unknown")) as string;

                  return (
                    <li key={area.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedAreaId(area.id)}
                        className={`w-full rounded-xl border px-4 py-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900 ${
                          active
                            ? "border-slate-900/20 bg-slate-50 ring-1 ring-slate-900/30 dark:border-zinc-600 dark:bg-zinc-800/60 dark:ring-zinc-600"
                            : "border-slate-200/80 bg-white hover:border-slate-300 hover:bg-slate-50/50 dark:border-zinc-700/60 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:hover:bg-zinc-800/40"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          {/* Radio indicator */}
                          <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                            active ? "border-slate-900 dark:border-zinc-100" : "border-slate-300 dark:border-zinc-600"
                          }`}>
                            {active && <div className="h-1.5 w-1.5 rounded-full bg-slate-900 dark:bg-zinc-100" />}
                          </div>

                          {/* Mini spatial preview */}
                          <MiniSpatialPreview channels={MOCK_AREA_CHANNELS[area.id] ?? []} />

                          {/* Name + channel count + activeStreamer */}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="text-xs font-semibold text-slate-800 dark:text-zinc-100">{area.name}</p>
                              {area.activeStreamer && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-amber-500 dark:bg-amber-500/20 dark:text-amber-400">
                                  <span className="h-1 w-1 animate-pulse rounded-full bg-amber-400" />
                                  {t("device.hue.areas.activeStreamer")}
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 text-[11px] text-slate-400 dark:text-zinc-500">
                              {t("device.hue.areas.channels", { count: area.channelCount })}
                            </p>
                          </div>

                          {/* Readiness badge */}
                          <span className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold ${
                            area.readiness?.ready
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                              : area.readiness
                                ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
                                : "bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400"
                          }`}>
                            {readinessLabel}
                          </span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        {/* Check Readiness button (shown after selection) */}
        {selectedAreaId ? (
          <div>
            <button
              type="button"
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-slate-900 hover:bg-slate-900 hover:text-white dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:border-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900"
            >
              {t("device.hue.actions.checkReadiness")}
            </button>
          </div>
        ) : null}

        {/* Channel map (shown after selection) — full width */}
        {selectedAreaId ? (
          <HueChannelMapPanel
            channels={MOCK_CHANNELS}
            isLoading={false}
            overrides={overrides}
            onSetRegion={(index, region) => {
              setOverrides((prev) => {
                if (region === null) {
                  const next = { ...prev };
                  delete next[index];
                  return next;
                }
                return { ...prev, [index]: region };
              });
            }}
          />
        ) : null}

        {selectedArea && (
          <p className="text-[11px] text-zinc-600">
            Secili: <strong className="text-zinc-300">{selectedArea.name}</strong>
            {" · "}overrides: {JSON.stringify(overrides)}
          </p>
        )}
      </div>
    </div>
  );
}
