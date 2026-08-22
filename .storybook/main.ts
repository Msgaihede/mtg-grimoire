import type { StorybookConfig } from "@storybook/react-vite";
import { fileURLToPath } from "node:url";

const fake = (name: string) => fileURLToPath(new URL(`./fake/${name}`, import.meta.url));

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx", "../.storybook/**/*.mdx"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y", "@storybook/addon-mcp"],
  framework: { name: "@storybook/react-vite", options: {} },
  // The app's `public/`, mounted at the Storybook root. It is here for one file —
  // `mtg-grimoire-mark.svg`, which `manager.ts` names as `brandImage` — and pointing at the
  // directory Vite already serves is deliberate rather than a shortcut: the mark the sidebar
  // draws and the favicon `index.html` asks for are then the same bytes, so a workbench
  // branded with last month's logo is not a state this tree can reach. One directory, two
  // consumers. Nothing else in `public/` is served to a story, because nothing else is in it.
  staticDirs: ["../public"],
  // The manager document's own favicon. Storybook injects its own unless the custom head
  // already carries a `<link rel="icon">`, so this replaces it rather than competing with it
  // — the tab is then the app's mark whether it is the workbench or the app in front of you.
  // A function, not a string, because the preset receives the head Storybook has built so far
  // and dropping it would take the addons' injections with it.
  managerHead: (head) =>
    `${head}<link rel="icon" type="image/svg+xml" href="./mtg-grimoire-mark.svg" />`,
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
      { find: /^@tauri-apps\/api\/window$/, replacement: fake("window.ts") },
      { find: /^@\/lib\/images$/, replacement: fake("images.ts") },
      { find: /^@\//, replacement: fileURLToPath(new URL("../src/", import.meta.url)) },
    ];
    return config;
  },
};

export default config;
