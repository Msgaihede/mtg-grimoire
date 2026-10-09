// The workspace's import rules, held over every file a package is written in.
//
//   1. A module in another package is imported by the package's name (`@grimoire/ui/lib/x`).
//   2. Inside `packages/ui`, `@/` is the package's own root. Nowhere else may use it.
//   3. A read of a file's text (`?raw`, `?url`) names the file by relative path, never by a
//      package's name: it reads the repository and imports no module.
//   4. A file Node loads itself imports by relative path: a Vite, Vitest or Storybook config, and
//      everything under `scripts/`. Vite bundles what its config reaches by path and leaves a
//      package name to Node, which runs another package's TypeScript only as far as it can strip
//      the types (measured 2026-10-08: an `enum` behind a package name failed the config's load,
//      and the same file by path built). And `scripts/web-deploy-probe.mjs` runs in a job that
//      installs nothing, where no workspace link exists.
//
// And the rule pnpm's layout cannot hold by itself: **a package declares what its files import.**
// pnpm links into a package's `node_modules` only what its manifest names — but Node goes on
// looking in every folder above, so a name the root declares resolves from any package, in every
// checkout and in CI, and a worktree under `.claude/worktrees/` reaches the main checkout's tree
// as well. `prosemirror-view` was imported for months on the strength of npm's hoisting. Nothing
// that runs the code can see this, so it is read here.
//
// Specifiers are found with the compiler, not a pattern: several tests in this tree hold sample
// source in strings (`apps/light/phone/fence.test.ts` spells an import of `@tauri-apps/plugin-os`
// in order to refuse it), and a pattern reads those as imports.
import { builtinModules } from "node:module";
import { posix } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const MANIFESTS = import.meta.glob(
  ["/package.json", "/packages/*/package.json", "/apps/*/package.json", "/infrastructure/*/package.json"],
  { query: "?raw", import: "default", eager: true },
);

// Vite needs both glob arguments as literals. `node_modules` is left out by Vite itself; a
// Tauri host's folder and a build's output hold no source of a package.
const CODE = import.meta.glob(
  [
    "/packages/**/*.{ts,tsx}",
    "/apps/**/*.{ts,tsx}",
    "/infrastructure/**/*.ts",
    "/.storybook/**/*.{ts,tsx}",
    "/scripts/**/*.mjs",
    "/*.{ts,js}",
    "!/apps/*/src-tauri/**",
    "!/apps/*/dist*/**",
    "!**/.wrangler/**",
  ],
  { query: "?raw", import: "default", eager: true },
);
const STYLES = import.meta.glob(
  ["/packages/**/*.css", "/apps/**/*.css", "/.storybook/**/*.{css,mdx}", "!/apps/*/src-tauri/**", "!/apps/*/dist*/**"],
  { query: "?raw", import: "default", eager: true },
);

/** The eight packages below the root, by folder. A file in none of them is the root's. */
const PACKAGES = Object.keys(MANIFESTS)
  .filter((path) => path !== "/package.json")
  .map((path) => ({ dir: path.slice(0, -"package.json".length), manifest: JSON.parse(MANIFESTS[path]) }))
  // The deploy tool's folder is npm's, with a lockfile of its own, and is no package of this workspace.
  .filter(({ manifest }) => manifest.name?.startsWith("@grimoire/"));
const ROOT = { dir: "/", manifest: JSON.parse(MANIFESTS["/package.json"]) };
const ownerOf = (path) => PACKAGES.find(({ dir }) => `${path}/`.startsWith(dir)) ?? ROOT;
const declares = ({ manifest }, name) =>
  manifest.name === name ||
  name in (manifest.dependencies ?? {}) ||
  name in (manifest.devDependencies ?? {}) ||
  name in (manifest.peerDependencies ?? {});

/** Rule 4. */
const NODE_LOADED = (path) =>
  /\.(mjs|cjs|js)$/.test(path) ||
  /\/vite(\.[\w-]+)*\.ts$/.test(path) ||
  path === "/vitest.config.ts" ||
  path === "/.storybook/main.ts";

/**
 * The one module that names another package's by path on purpose. Both of the fake's hosts alias
 * the real images module's names to this file, so named either way an alias matches, its
 * re-export would be the file importing itself (the file's own header).
 */
const BY_PATH_ON_PURPOSE = ["/packages/fake/images.ts"];

const MOCKS = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"]);

/** Every module specifier `source` names, wherever TypeScript lets one be written. */
function specifiersOf(path, source) {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.(mjs|js)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, kind);
  const out = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      out.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isMock =
        ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "vi" && MOCKS.has(callee.name.text);
      if (isImport || isRequire || isMock) out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  // `/// <reference types="vite/client" />` is a dependency the compiler resolves like an import.
  for (const [, name] of source.matchAll(/^\/\/\/\s*<reference\s+types="([^"]+)"/gm)) out.push(name);
  return out;
}

/**
 * What a stylesheet or an MDX page names: `@import "x"`, `@plugin "x"`, and `import … from "x"`.
 * Comments go first: every app's stylesheet quotes the shared one's `@import "tailwindcss"` in
 * the prose above its own imports.
 */
function styleSpecifiersOf(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  return [
    ...[...code.matchAll(/@(?:import|plugin|config)\s+["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...code.matchAll(/^import\s[^"']*["']([^"']+)["']/gm)].map((m) => m[1]),
  ];
}

const isRelative = (spec) => spec.startsWith(".");
const isBare = (spec) => !isRelative(spec) && !spec.startsWith("/") && !spec.startsWith("@/") && !/^[a-z]+:/.test(spec);
const BUILTINS = new Set(builtinModules);
/** `@scope/name/deep/path?raw` → `@scope/name`. */
const packageOf = (spec) => spec.split("?")[0].split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");

/** Every breach in a tree of sources, one line each. */
function breachesIn(code, styles = {}) {
  const undeclared = [];
  const alias = [];
  const byPath = [];
  const textByName = [];
  for (const [path, source] of Object.entries(code)) {
    const owner = ownerOf(path);
    for (const spec of specifiersOf(path, source)) {
      if (spec.startsWith("@/")) {
        if (owner.manifest.name !== "@grimoire/ui") alias.push(`${path} → ${spec}`);
      } else if (isRelative(spec)) {
        if (spec.includes("?") || NODE_LOADED(path) || BY_PATH_ON_PURPOSE.includes(path)) continue;
        const target = posix.join(posix.dirname(path), spec);
        const other = ownerOf(target);
        // A file the root owns is no package's module, so a path is the only way to name it:
        // `packages/ui/stories.test.tsx` imports the workbench's `.storybook/preview` this way.
        if (other !== owner && other !== ROOT) byPath.push(`${path} → ${spec}`);
      } else if (isBare(spec)) {
        // Rule 3's other half: a text read through a package's name. It resolves, and
        // `scripts/ci-route.test.mjs` would then take it for a third-party package and leave the
        // file it reads out of the census that routes CI.
        if (spec.includes("?") && packageOf(spec).startsWith("@grimoire/")) textByName.push(`${path} → ${spec}`);
        if (!BUILTINS.has(packageOf(spec)) && !declares(owner, packageOf(spec))) {
          undeclared.push(`${path} → ${packageOf(spec)}`);
        }
      }
    }
  }
  for (const [path, source] of Object.entries(styles)) {
    const owner = ownerOf(path);
    for (const spec of styleSpecifiersOf(source)) {
      if (isBare(spec) && !declares(owner, packageOf(spec))) undeclared.push(`${path} → ${packageOf(spec)}`);
    }
  }
  return { undeclared: [...new Set(undeclared)], alias, byPath, textByName };
}

describe("the workspace's packages", () => {
  it("are the eight, each private and at 0.0.0, and the root", () => {
    expect(PACKAGES.map(({ dir, manifest }) => `${dir} ${manifest.name}`).sort()).toEqual([
      "/apps/desktop/ @grimoire/desktop",
      "/apps/light/ @grimoire/light",
      "/apps/share/ @grimoire/share",
      "/infrastructure/app-worker/ @grimoire/app-worker",
      "/infrastructure/relay/ @grimoire/relay",
      "/infrastructure/share-worker/ @grimoire/share-worker",
      "/packages/fake/ @grimoire/fake",
      "/packages/ui/ @grimoire/ui",
    ]);
    // release-please bumps the root's version and no other: a package with a version of its own
    // is one more file a release would have to move.
    for (const { dir, manifest } of PACKAGES) {
      expect(manifest.version, dir).toBe("0.0.0");
      expect(manifest.private, dir).toBe(true);
    }
    expect(ROOT.manifest.name).toBe("mtg-grimoire");
  });

  it("depend on each other as the design says, and on no app", () => {
    const links = Object.fromEntries(
      [ROOT, ...PACKAGES].map(({ manifest }) => [
        manifest.name,
        Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
          .filter((name) => name.startsWith("@grimoire/"))
          .sort(),
      ]),
    );
    expect(links).toEqual({
      "mtg-grimoire": ["@grimoire/fake", "@grimoire/ui"],
      "@grimoire/ui": ["@grimoire/fake"],
      "@grimoire/fake": ["@grimoire/ui"],
      "@grimoire/desktop": ["@grimoire/fake", "@grimoire/ui"],
      "@grimoire/light": ["@grimoire/fake", "@grimoire/ui"],
      "@grimoire/share": ["@grimoire/ui"],
      "@grimoire/relay": [],
      "@grimoire/share-worker": ["@grimoire/relay"],
      "@grimoire/app-worker": ["@grimoire/ui"],
    });
    // The shared UI reaches the fake from its tests and stories only.
    const ui = PACKAGES.find(({ manifest }) => manifest.name === "@grimoire/ui").manifest;
    expect(Object.keys(ui.dependencies).filter((name) => name.startsWith("@grimoire/"))).toEqual([]);
  });
});

describe("what each package imports", () => {
  const { undeclared, alias, byPath, textByName } = breachesIn(CODE, STYLES);

  it("is declared in that package's own manifest", () => {
    expect(undeclared).toEqual([]);
  });

  it("uses `@/` only inside the shared UI", () => {
    expect(alias).toEqual([]);
  });

  it("names another package's module by the package, not by a path", () => {
    expect(byPath).toEqual([]);
  });

  it("reads another package's file as text by its path, not by the package's name", () => {
    expect(textByName).toEqual([]);
  });
});

describe("the rule's own guards", () => {
  // A sweep over nothing passes everything above.
  it("reads the tree", () => {
    expect(Object.keys(CODE).length).toBeGreaterThan(1200);
    expect(Object.keys(STYLES)).toContain("/packages/ui/index.css");
    expect(Object.keys(CODE).filter((path) => path.includes("/node_modules/"))).toEqual([]);
    expect(specifiersOf("/apps/light/main.tsx", CODE["/apps/light/main.tsx"])).toContain("react-dom/client");
    expect(styleSpecifiersOf(STYLES["/packages/ui/index.css"])).toContain("tailwindcss");
  });

  it("finds each breach in a tree that has one", () => {
    const tree = {
      "/apps/light/phone/A.tsx": [
        `import { x } from "@/lib/x";`,
        `import { y } from "../../../packages/ui/lib/y";`,
        `import text from "../../../packages/ui/lib/y.ts?raw";`,
        `import css from "@grimoire/ui/index.css?raw";`,
        `import { z } from "left-pad";`,
        `import { useState } from "react";`,
        `import { w } from "@grimoire/ui/lib/w";`,
        `vi.mock("@grimoire/relay/src/token", () => ({}));`,
        `const lazy = await import("some-lazy-package/deep");`,
        `type T = typeof import("a-types-package");`,
        `const sample = 'import { no } from "not-an-import";';`,
        `// import { no } from "nor-this";`,
      ].join("\n"),
      "/packages/ui/lib/x.ts": `import { y } from "@/lib/y";`,
      "/packages/fake/images.ts": `export * from "../ui/lib/images";`,
      "/packages/fake/db.ts": `import { v } from "../ui/lib/v";`,
      "/apps/light/vite.config.ts": `import { a } from "../../packages/fake/aliases.ts";`,
      "/scripts/probe.mjs": `import { h } from "../infrastructure/app-worker/src/headers.ts";`,
    };
    expect(breachesIn(tree, { "/apps/light/mobile.css": `@import "../../packages/ui/index.css";\n@import "a-css-package";` })).toEqual({
      undeclared: [
        "/apps/light/phone/A.tsx → left-pad",
        "/apps/light/phone/A.tsx → @grimoire/relay",
        "/apps/light/phone/A.tsx → some-lazy-package",
        "/apps/light/phone/A.tsx → a-types-package",
        "/apps/light/mobile.css → a-css-package",
      ],
      alias: ["/apps/light/phone/A.tsx → @/lib/x"],
      byPath: ["/apps/light/phone/A.tsx → ../../../packages/ui/lib/y", "/packages/fake/db.ts → ../ui/lib/v"],
      textByName: ["/apps/light/phone/A.tsx → @grimoire/ui/index.css?raw"],
    });
  });

  it("names files that exist as its exceptions", () => {
    for (const path of BY_PATH_ON_PURPOSE) expect(Object.keys(CODE)).toContain(path);
  });
});
