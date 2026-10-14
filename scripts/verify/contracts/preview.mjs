import { resolve } from "node:path";

import { ROOT, check, readOrEmpty, stripComments, constMembers, checkWireUnion } from "./lib.mjs";
import { previewSource } from "./sources.mjs";

// ---------------------------------------------------------------------------
// LED preview contract: the test-pattern commands LED Setup and Devices use,
// and the preview session (popup + twin) that Lights and the tray open.
// ---------------------------------------------------------------------------

console.log("\n[ Preview status codes — Rust ↔ preview.ts ]");
{
  const rustPreview = ["session.rs", "feed.rs", "scene.rs"]
    .map((file) =>
      stripComments(readOrEmpty(resolve(ROOT, "src-tauri/src/commands/preview", file), `rust preview ${file}`))
    )
    .join("\n");
  checkWireUnion(
    "PreviewStatusCode",
    [...rustPreview.matchAll(/const PREVIEW_[A-Z_]+: &str = "([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]),
    constMembers(previewSource, "PREVIEW_STATUS"),
    // 7 → 8: PREVIEW_TWIN_SUBSCRIBED, the twin's frame subscription (feed.rs).
    // 8 → 9: PREVIEW_TWIN_UPDATED, the popup's twin switch (session.rs).
    // 9 → 19: the scene commands' ten codes (scene.rs).
    19
  );
}

console.log("\n[ Preview event + window labels (v1.6) ]");
check(
  previewSource.includes(`"led-twin-overlay-"`),
  "LED_TWIN_OVERLAY_LABEL_PREFIX defined",
  "MISSING LED_TWIN_OVERLAY_LABEL_PREFIX in preview.ts"
);
check(
  previewSource.includes(`"led-control-popup-"`),
  "LED_CONTROL_POPUP_LABEL_PREFIX defined",
  "MISSING LED_CONTROL_POPUP_LABEL_PREFIX in preview.ts"
);
check(
  previewSource.includes(`"led-preview-scene-"`),
  "LED_PREVIEW_SCENE_LABEL_PREFIX defined",
  "MISSING LED_PREVIEW_SCENE_LABEL_PREFIX in preview.ts"
);

console.log("\n[ LED test pattern kinds — Rust ↔ preview.ts parity ]");
const rustTestPatternSource = readOrEmpty(
  resolve(ROOT, "src-tauri/src/commands/test_pattern.rs"),
  "rust test_pattern"
);
const rustPatternBlock = rustTestPatternSource.match(/pub enum TestPatternKind\s*\{([\s\S]*?)\n\}/);
const rustPatternKinds = rustPatternBlock
  ? [...rustPatternBlock[1].matchAll(/^    ([A-Z][A-Za-z]*)\b/gm)].map(
      (m) => m[1][0].toLowerCase() + m[1].slice(1)
    )
  : [];
const tsPatternBlock = previewSource.match(/LED_TEST_PATTERN_KIND\s*=\s*\[([\s\S]*?)\]\s*as const/);
const tsPatternKinds = tsPatternBlock
  ? [...tsPatternBlock[1].matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1])
  : [];
check(
  rustPatternKinds.length > 0 && tsPatternKinds.length > 0,
  `extracted ${rustPatternKinds.length} Rust / ${tsPatternKinds.length} TS test pattern kinds`,
  "EXTRACTION FAILED: could not read Rust TestPatternKind or TS LED_TEST_PATTERN_KIND"
);
check(
  rustPatternKinds.join(",") === tsPatternKinds.join(","),
  `LED_TEST_PATTERN_KIND matches Rust TestPatternKind in order (${tsPatternKinds.join(" ")})`,
  `TEST PATTERN DRIFT:\n     Rust: ${rustPatternKinds.join(" ")}\n     TS  : ${tsPatternKinds.join(" ")}`
);
