// `embedded` provider: WebDriver runs inside the app, because `tauri-driver` is
// Windows+Linux only (tauri-apps/tauri#7068). Run via `pnpm e2e`, which
// rebuilds: `cargo test` emits a dev-cfg binary to this same path that loads
// the Vite dev URL instead of embedded assets, so the window comes up blank.

import type { TauriCapabilities } from "@wdio/tauri-service";

const IS_CI = Boolean(process.env.CI);

// `tauri:options` is a service-owned key; it does not widen WebdriverIO's
// standalone capability union, so the cast is the supported spelling.
const capabilities = [
  {
    browserName: "tauri",
    "tauri:options": {
      application: "./src-tauri/target/debug/lumasync",
    },
  } satisfies TauriCapabilities,
] as unknown as WebdriverIO.Config["capabilities"];

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./e2e/specs/**/*.e2e.ts"],

  // The embedded server binds one port per app instance; parallel workers would
  // fight over it, and a tray-first single-window app has nothing to parallelise.
  maxInstances: 1,

  capabilities,

  services: [["tauri", { driverProvider: "embedded" }]],

  framework: "mocha",
  reporters: ["spec"],
  logLevel: IS_CI ? "warn" : "error",

  // The window is created hidden and only shown once the React bootstrap
  // finishes (windowLifecycle.ts), so first paint trails process start.
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,

  // Every command crosses the in-process WebDriver bridge into
  // `evaluateJavaScript`, which is an order slower than a Chromium socket.
  mochaOpts: {
    ui: "bdd",
    timeout: 180_000,
  },
};
