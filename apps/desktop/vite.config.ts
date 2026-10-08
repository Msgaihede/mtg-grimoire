import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import base from "../../vite.base.ts";

// The desktop app's page: `index.html` and `src/main.tsx` here, everything else from the shared
// UI. `root` is this folder whatever the working directory, so `dist/` lands beside it — where
// `src-tauri/tauri.conf.json`'s `frontendDist: "../dist"` reads it.
export default mergeConfig(
  base,
  defineConfig({ root: fileURLToPath(new URL("./", import.meta.url)) }),
);
