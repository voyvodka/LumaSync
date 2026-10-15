import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { LampFamily } from "@/features/room-view/model/lampFamily";

import type { ViewLight } from "../../model/viewLights";

// Spelled out so the key check sees every one: a fixture is not a contract value it could read.
const FAMILY_KEY = {
  playBar: "roomMap:view.family.playBar",
  lightstrip: "roomMap:view.family.lightstrip",
  floorLamp: "roomMap:view.family.floorLamp",
  signe: "roomMap:view.family.signe",
  tableLamp: "roomMap:view.family.tableLamp",
  pendant: "roomMap:view.family.pendant",
  ceiling: "roomMap:view.family.ceiling",
  portable: "roomMap:view.family.portable",
  spot: "roomMap:view.family.spot",
  wall: "roomMap:view.family.wall",
  tube: "roomMap:view.family.tube",
  bulb: "roomMap:view.family.bulb",
} as const satisfies Record<LampFamily, string>;

/** A light's facts in reading order — zone, fixture, how many lights — each left out when it is not
 *  known, so nothing is shown as a guess. */
export function useViewLightFacts(): (light: ViewLight) => string {
  const { t } = useTranslation();
  return useCallback(
    (light: ViewLight) => {
      if (light.kind === "tv") return t("roomMap:view.tvBacklight");
      if (light.kind === "usb") return t("roomMap:view.strip");
      const parts = [
        light.zone?.name,
        light.family ? t(FAMILY_KEY[light.family]) : undefined,
        light.lightCount !== null && light.lightCount > 1 ? t("roomMap:view.lightCount", { count: light.lightCount }) : undefined,
      ];
      return parts.filter((part): part is string => !!part).join(" · ");
    },
    [t],
  );
}

/** What a chip says to a screen reader and in its tooltip: the name, then its facts. */
export function useViewLightLabel(): (light: ViewLight) => string {
  const { t } = useTranslation();
  const facts = useViewLightFacts();
  return useCallback(
    (light: ViewLight) => {
      const known = facts(light);
      const base = known ? `${light.name}, ${known}` : light.name;
      return light.ghost ? `${base} — ${t("roomMap:inspector.hueGhostShort")}` : base;
    },
    [facts, t],
  );
}
