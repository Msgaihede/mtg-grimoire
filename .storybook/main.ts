import type { StorybookConfig } from "@storybook/react-vite";
import { fileURLToPath } from "node:url";

const fake = (name: string) => fileURLToPath(new URL(`./fake/${name}`, import.meta.url));

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx", "../.storybook/**/*.mdx"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  framework: { name: "@storybook/react-vite", options: {} },
  // Off because this repo's one external dependency is Scryfall and the shipped app runs a
  // CSP with no remote source. A dev tool that phones home on every build does not get to be
  // the exception.
  core: { disableTelemetry: true },
  viteFinal: (config) => {
    config.resolve ??= {};
    // An array, not an object: these are exact-match rules and their order is the
    // contract. `@/lib/images` must be tried before the bare `@` prefix.
    config.resolve.alias = [
      { find: /^@tauri-apps\/api\/core$/, replacement: fake("core.ts") },
      { find: /^@tauri-apps\/api\/event$/, replacement: fake("event.ts") },
      { find: /^@\/lib\/images$/, replacement: fake("images.ts") },
      { find: /^@\//, replacement: fileURLToPath(new URL("../src/", import.meta.url)) },
    ];
    return config;
  },
};

export default config;
