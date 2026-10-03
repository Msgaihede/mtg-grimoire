import type { StorybookConfig } from "@storybook/react-vite";
import { fileURLToPath } from "node:url";
import { WATCH_IGNORED } from "../vite.watch.ts";
import { FAKE_ALIASES } from "./fake/aliases.ts";

/**
 * The two pieces of Node's `process` this file reads, typed at the one place they are read.
 *
 * **Not `@types/node`, and not a `declare global` either**, for the reason `node-url.d.ts` gives
 * at length: this program also type-checks `preview.tsx` and the whole fake, which run in a
 * browser, so an ambient `process` would type-check `process.env.FOO` in every one of them. A
 * cast on a single `globalThis` read keeps the claim inside the one file that runs in Node.
 *
 * **`getBuiltinModule` rather than `import … from "node:fs"`**, because an import needs a module
 * declaration and `node-url.d.ts` holds exactly one, deliberately. This asks the running Node for
 * the module instead — Node 22.3 and later; `.nvmrc` pins 24.
 */
const node = (
  globalThis as unknown as {
    process: {
      env: Record<string, string | undefined>;
      getBuiltinModule(id: "node:fs"): { existsSync(path: string): boolean };
    };
  }
).process;

/**
 * The design system's card art, served at `/card-art` — for a build that asked for it, and only
 * once it has been downloaded.
 *
 * `STORYBOOK_ART=bundled` is what `.design-sync/build-reference.mjs` sets, and it is the whole
 * switch: `preview.tsx` reads the same variable to open the Art toolbar on `bundled`, so the
 * reference storybook the sync compares against draws the same JPGs the bundle's previews do. The
 * folder is `.design-sync/card-art.mjs`'s download, gitignored, and its name here is
 * `CARD_ART_DIR` in `fake/images.ts` — restated rather than imported, because that module brings
 * the whole fixture into a file that runs in Node.
 *
 * **Checked for, because Storybook refuses a static directory that is not there** — `storybook
 * build` throws `Failed to load static files, no such directory`, and a dev server logs it and
 * serves nothing. Without the folder the art still says `bundled` and every card draws the app's
 * own no-image frame, which is the honest picture of a missing download, and the warning says so.
 */
const CARD_ART = "../.design-sync/card-art";
const bundledArt =
  node.env.STORYBOOK_ART === "bundled" &&
  node.getBuiltinModule("node:fs").existsSync(fileURLToPath(new URL(CARD_ART, import.meta.url)));
if (node.env.STORYBOOK_ART === "bundled" && !bundledArt) {
  console.warn(
    "STORYBOOK_ART=bundled, but .design-sync/card-art/ does not exist, so every card will draw " +
      "its no-image frame. Run `node .design-sync/card-art.mjs` first.",
  );
}

const config: StorybookConfig = {
  // `mobile/` since phase 3: the light app's phone face is its own UI, and its pieces are storied
  // where they live (`mobile/CLAUDE.md`). `preview.css` scans the same directory for classes.
  stories: ["../src/**/*.stories.tsx", "../mobile/**/*.stories.tsx", "../.storybook/**/*.mdx"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y", "@storybook/addon-mcp"],
  framework: { name: "@storybook/react-vite", options: {} },
  // The app's `public/`, mounted at the Storybook root. It is here for one file —
  // `mtg-grimoire-mark.svg`, which `manager.ts` names as `brandImage` — and pointing at the
  // directory Vite already serves is deliberate rather than a shortcut: the mark the sidebar
  // draws and the favicon `index.html` asks for are then the same bytes, so a workbench
  // branded with last month's logo is not a state this tree can reach. One directory, two
  // consumers. Nothing else in `public/` is served to a story, because nothing else is in it.
  //
  // The card art joins it only under `STORYBOOK_ART=bundled`; see `bundledArt` above.
  staticDirs: bundledArt ? ["../public", { from: CARD_ART, to: "/card-art" }] : ["../public"],
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
    // contract. `@/lib/images` must be tried before the bare `@` prefix. The fake's four are
    // `fake/aliases.ts`'s, which `vite.mobile.config.ts` reads too.
    config.resolve.alias = [
      ...FAKE_ALIASES,
      { find: /^@\//, replacement: fileURLToPath(new URL("../src/", import.meta.url)) },
    ];
    // **The dev server does not inherit `vite.config.ts`'s `server` block — the builder replaces
    // it.** `@storybook/builder-vite` loads that file and then spreads a `server` of its own over
    // the result (`createViteServer`, read at 10.6.0), so `server.watch.ignored` never arrived:
    // this server watched every build output under the root, all of `src-tauri/target` included,
    // which the app's own server has never done. Driven 2026-10-01, it exited on `EBUSY` under
    // `crates/card-scanner/target` during a cargo build exactly as the plain Vite servers did.
    // `vite.watch.ts` is the list and the why. `storybook build` keeps the base config's `server`
    // and has no watcher, so there this assigns the list it already had.
    config.server = {
      ...config.server,
      watch: { ...config.server?.watch, ignored: WATCH_IGNORED },
    };
    return config;
  },
};

export default config;
