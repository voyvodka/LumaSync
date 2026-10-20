import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ROOT, readOrEmpty, walkSourceFiles } from "./lib.mjs";

export const CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/shell.ts");

export let source;
try {
  source = readFileSync(CONTRACT_FILE, "utf-8");
  console.log(`\nFile: ${CONTRACT_FILE}`);
} catch (err) {
  console.error(`\nFATAL: Cannot read contract file: ${CONTRACT_FILE}`);
  console.error(err.message);
  process.exit(1);
}

export const HUE_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/hue.ts");
export const hueSource = readOrEmpty(HUE_CONTRACT_FILE, "hue");
export const DEVICE_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/device.ts");
export const deviceSource = readOrEmpty(DEVICE_CONTRACT_FILE, "device");
export const RUST_HEALTH_CHECK_RESULT_FILE = resolve(
  ROOT,
  "src-tauri/src/commands/device_connection.rs"
);
export const rustHealthSource = readOrEmpty(RUST_HEALTH_CHECK_RESULT_FILE, "rust device_connection");
export const rustLocalOutputsSource = readOrEmpty(
  resolve(ROOT, "src-tauri/src/commands/local_outputs.rs"),
  "rust local_outputs"
);
export const CALIBRATION_CONTRACT_FILE = resolve(
  ROOT,
  "src/shared/contracts/calibration.ts"
);
export const calibrationSource = readOrEmpty(CALIBRATION_CONTRACT_FILE, "calibration");
export const PLATFORM_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/platform.ts");
export const platformSource = readOrEmpty(PLATFORM_CONTRACT_FILE, "platform");
export const ROOM_MAP_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/roomMap.ts");
export const roomMapSource = readOrEmpty(ROOM_MAP_CONTRACT_FILE, "room map");
// The commands Rust registers, read once for the ACL manifest and the command-name parity (commands.mjs).
export const RUST_LIB_FILE = resolve(ROOT, "src-tauri/src/lib.rs");
export const rustLibSource = readOrEmpty(RUST_LIB_FILE, "rust lib.rs");
export const handlerListMatch = rustLibSource.match(/generate_handler!\[([\s\S]*?)\]/);
export const handlerListBlock = handlerListMatch ? handlerListMatch[1] : "";
export const WLED_DISCOVERY_FILE = resolve(
  ROOT,
  "src-tauri/src/commands/wled_discovery.rs"
);
export const wledRustSource = readOrEmpty(WLED_DISCOVERY_FILE, "wled_discovery.rs");
export const PREVIEW_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/preview.ts");
export const previewSource = readOrEmpty(PREVIEW_CONTRACT_FILE, "preview");
export const LIGHTING_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/lighting.ts");
export const RUST_LIGHTING_MODE_FILE = resolve(ROOT, "src-tauri/src/commands/lighting_mode/transition.rs");
export const lightingSource = readOrEmpty(LIGHTING_CONTRACT_FILE, "lighting");
export const rustLightingSource = readOrEmpty(RUST_LIGHTING_MODE_FILE, "rust lighting_mode");
export const TELEMETRY_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/telemetry.ts");
export const RUST_TELEMETRY_FILE = resolve(ROOT, "src-tauri/src/commands/runtime_telemetry.rs");
export const telemetrySource = readOrEmpty(TELEMETRY_CONTRACT_FILE, "telemetry");
export const rustTelemetrySource = readOrEmpty(RUST_TELEMETRY_FILE, "rust runtime_telemetry");
export const tsSourceFiles = walkSourceFiles(resolve(ROOT, "src"), /\.tsx?$/);
export const CAPTURE_CONTRACT_FILE = resolve(ROOT, "src/shared/contracts/capture.ts");
export const captureContractSource = readOrEmpty(CAPTURE_CONTRACT_FILE, "capture contract");
export const contractModuleFiles = walkSourceFiles(resolve(ROOT, "src/shared/contracts"), /\.ts$/);
export const runtimeSourceFiles = tsSourceFiles.filter((f) => !f.includes("/shared/contracts/"));
