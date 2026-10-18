import { resolve } from "node:path";

import { ROOT, check, readOrEmpty } from "./lib.mjs";
import { roomMapSource } from "./sources.mjs";

// ---------------------------------------------------------------------------
// Room map contract
// ---------------------------------------------------------------------------

console.log("\n[ Room map contract types ]");
// `ZoneDefinition` and `LegacyHueZone` survive as @deprecated migration-shim
// types (consumed by `migrateLegacyHueZone` and the logical-zone drop path);
// `HueZone` is the canonical authoring type and MUST be present alongside
// them.
const REQUIRED_ROOM_MAP_TYPES = [
  "RoomDimensions",
  "HueChannelPlacement",
  "UsbStripPlacement",
  "FurniturePlacement",
  "TvAnchorPlacement",
  "ZoneDefinition",
  "LegacyHueZone",
  "HueZone",
  "RoomMapConfig",
];
for (const typeName of REQUIRED_ROOM_MAP_TYPES) {
  check(
    roomMapSource.includes(`export interface ${typeName}`),
    `room map type "${typeName}" exported`,
    `MISSING room map type "${typeName}" in roomMap.ts`
  );
}

// ---------------------------------------------------------------------------
// TV mount-height default. The inspector shows it as the placeholder and the
// worker resolves an absent mount height with it; a drift means the field
// promises a height the lights never sample at.
// ---------------------------------------------------------------------------
console.log("\n[ TV mount-height default — Rust ↔ roomMap.ts parity ]");
const RUST_ROOM_AFFINITY_FILE = resolve(ROOT, "src-tauri/src/commands/room_affinity.rs");
const rustRoomAffinitySource = readOrEmpty(RUST_ROOM_AFFINITY_FILE, "rust room_affinity");
const rustMountFraction = rustRoomAffinitySource.match(
  /pub\s+const\s+DEFAULT_TV_MOUNT_HEIGHT_FRACTION\s*:\s*f64\s*=\s*([0-9.]+)\s*;/
);
const tsMountFraction = roomMapSource.match(
  /export\s+const\s+DEFAULT_TV_MOUNT_HEIGHT_FRACTION\s*=\s*([0-9.]+)\s*;/
);
check(
  rustMountFraction !== null && tsMountFraction !== null,
  "extracted DEFAULT_TV_MOUNT_HEIGHT_FRACTION from room_affinity.rs and roomMap.ts",
  `EXTRACTION FAILED: DEFAULT_TV_MOUNT_HEIGHT_FRACTION missing in `
    + `${rustMountFraction ? "roomMap.ts" : "room_affinity.rs"}`
);
check(
  rustMountFraction !== null
    && tsMountFraction !== null
    && Number(rustMountFraction[1]) === Number(tsMountFraction[1]),
  `TV mount-height default matches Rust (${rustMountFraction ? rustMountFraction[1] : "?"})`,
  `MOUNT FRACTION DRIFT: Rust=${rustMountFraction ? rustMountFraction[1] : "?"} `
    + `vs roomMap.ts=${tsMountFraction ? tsMountFraction[1] : "?"}`
);
