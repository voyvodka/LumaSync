import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { version } = JSON.parse(readFileSync("./package.json", "utf-8")) as { version: string };

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const MOCK_ENV_VAR = "LUMASYNC_MOCK";
const MOCK_ENTRY = "/mock/boot.ts";
const MOCK_SHIM = fileURLToPath(new URL("./mock/tauriCoreShim.ts", import.meta.url));

/**
 * Dev mock wiring. Two plugins, both `apply: "serve"`, both registered only when
 * `LUMASYNC_MOCK=1`.
 *
 * Nothing under `src/` may ever name `mock/`. That absence is the ship-safety
 * guarantee — the production module graph has no edge to reach, so there is no
 * tree-shaking to trust — and `scripts/verify/mock-not-shipped.mjs` asserts it.
 *
 * The redirect matches the *resolved* path rather than the specifier because the
 * sibling api modules import `./core.js` relatively while the six plugins use the
 * bare `@tauri-apps/api/core`. A string alias would catch only the latter, which
 * is 12 of 33 import sites.
 */
function devMockPlugins(): Plugin[] {
  return [
    {
      name: "lumasync:mock-boot",
      apply: "serve",
      transformIndexHtml: {
        order: "pre",
        handler: () => [
          { tag: "script", attrs: { type: "module", src: MOCK_ENTRY }, injectTo: "head-prepend" },
        ],
      },
    },
    {
      name: "lumasync:mock-core",
      apply: "serve",
      enforce: "pre",
      async resolveId(source, importer, options) {
        // The shim imports the real module; without this it would resolve to itself.
        if (importer !== undefined && importer.includes("/mock/")) {
          return null;
        }
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
        return resolved !== null && /@tauri-apps[\\/]api[\\/]core\.js$/.test(resolved.id)
          ? MOCK_SHIM
          : null;
      },
    },
  ];
}

// @ts-expect-error process is a nodejs global
const mockRequested = process.env[MOCK_ENV_VAR] === "1";

// https://vite.dev/config/
export default defineConfig(async ({ command }) => {
  // A stray export in the developer's shell must not reach a shipped bundle.
  // `e2e:build` gets here too, through Tauri's `beforeBuildCommand`.
  if (mockRequested && command === "build") {
    throw new Error(
      `${MOCK_ENV_VAR}=1 during a production build. The dev mock must never be bundled — unset it and rebuild.`,
    );
  }

  return {
    plugins: [tailwindcss(), react(), ...(mockRequested ? devMockPlugins() : [])],

    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },

    build: {
      // Vite's 500 kB default warns about download cost, which a bundle read off
      // local disk never pays. Kept just above the largest chunk (the entry every
      // window parses) so it still ratchets — see docs/architecture/build-and-release.md.
      chunkSizeWarningLimit: 300,
    },

    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
