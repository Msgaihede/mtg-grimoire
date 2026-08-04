import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { woff2Only } from "./src/lib/iconFont";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/** `mana-font/css/mana.css` and `keyrune/css/keyrune.css`, however they are imported. */
const ICON_FONT_CSS = /node_modules[\\/](mana-font|keyrune)[\\/]css[\\/][^\\/]+\.css$/;

/**
 * Ship one format of the icon fonts instead of five — see `src/lib/iconFont.ts` for what
 * the rewrite does and why, and `iconFont.test.ts` for the guarantee that it leaves every
 * glyph class alone. Worth ~5 MB of the bundle.
 *
 * `enforce: "pre"` so this runs before Vite's CSS plugin turns the `url()`s into emitted
 * assets. It only sees these files because `main.tsx` imports them: an `@import` from
 * `index.css` is inlined by Tailwind before Vite resolves it as a module, and the rules
 * would never reach a transform hook.
 */
function woff2IconFonts(): Plugin {
  return {
    name: "woff2-icon-fonts",
    enforce: "pre",
    transform(code, id) {
      // No query suffix: `?raw` is how `iconFont.test.ts` reads these files as they ship,
      // and transforming that would have the test grade its own output.
      if (!ICON_FONT_CSS.test(id)) return null;
      return { code: woff2Only(code), map: null };
    },
  };
}

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
    include: ["src/**/*.test.{ts,tsx}"],
    // Vitest stubs CSS imports as empty strings by default, which would hand
    // `iconFont.test.ts` an empty `mana.css?raw` to assert against. No component imports
    // CSS, so those two files are the whole of what this turns on.
    css: true,
  },
});
