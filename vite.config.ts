import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// Ships one format of the icon fonts instead of five — worth ~5 MB of the bundle. Both
// the rewrite and its `id` filter live under `src/` so the test suite covers them; see
// `src/lib/iconFont.ts` for why, and `iconFont.test.ts` for the guarantee that it leaves
// every glyph class alone.
import { woff2IconFonts } from "./src/lib/iconFont";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [woff2IconFonts(), react(), tailwindcss()],

  // `@/*` -> `src/*`, matching tsconfig.json paths and components.json aliases.
  resolve: {
    alias: { "@": "/src" },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
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
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // `.storybook` is in scope so the fake backend is covered by the one suite `verify`
    // runs. `.test.ts` and not `.test.{ts,tsx}`: the fakes are plain modules, and the
    // narrower glob is also what keeps `*.stories.tsx` — which Storybook collects and
    // Vitest must not — out of the run.
    include: ["src/**/*.test.{ts,tsx}", ".storybook/**/*.test.ts"],
    // Vitest stubs CSS imports as empty strings by default, which would hand
    // `iconFont.test.ts` an empty `mana.css?raw` to assert against. No component imports
    // CSS, so those two files are the whole of what this turns on.
    css: true,
  },
});
