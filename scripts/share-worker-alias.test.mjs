// What the share Worker's script imports, in a job that installs only wrangler —
// `release.yml`'s `share-deploy` checks the repository out and runs no pnpm, so nothing links
// `@grimoire/relay` into that folder there. `infrastructure/app-worker/src/hosting.test.ts`
// holds the same rule for the web app's Worker.
import { describe, expect, it } from "vitest";
import wranglerText from "../infrastructure/share-worker/wrangler.jsonc?raw";
import tokenText from "../infrastructure/relay/src/token.ts?raw";

const OWN = import.meta.glob("/infrastructure/share-worker/src/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The config as a value: comments and trailing commas out, strings left alone. */
function jsonc(text) {
  const bare = text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, string) => string ?? "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(bare);
}

/** Every specifier a source names — `from "x"`, `import "x"`, `import("x")` — comments out. */
const named = (source) =>
  [
    ...source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
      .matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g),
  ].map(([, spec]) => spec);

describe("what the share Worker's script imports, in a job that installs only wrangler", () => {
  /** The script: the folder's modules by `./name.ts`, less the tests and the declarations. */
  const script = Object.entries(OWN)
    .map(([path, source]) => [`./${path.slice(path.lastIndexOf("/") + 1)}`, source])
    .filter(([path]) => !/\.(?:test|d)\.ts$/.test(path));

  it("is a file beside it, or a module `wrangler.jsonc` gives a path for", () => {
    const paths = script.map(([path]) => path).sort();
    expect(paths).toContain("./index.ts");
    const specs = script.flatMap(([, source]) => named(source));
    for (const spec of specs.filter((s) => s.startsWith("."))) {
      expect(paths, spec).toContain(`${spec}.ts`);
    }
    const outside = [...new Set(specs.filter((spec) => !spec.startsWith(".")))];
    expect(outside).toEqual(["@grimoire/relay/src/token"]);
    // An exact module, not the package: wrangler matches an alias against the whole specifier.
    expect(jsonc(wranglerText).alias).toEqual({
      "@grimoire/relay/src/token": "../relay/src/token.ts",
    });
  });

  it("reaches a module that imports nothing of its own", () => {
    expect(tokenText).toContain("export async function verify");
    expect(named(tokenText)).toEqual([]);
  });

  it("reads a config with comments, a URL in a string and a trailing comma", () => {
    expect(
      jsonc('{\n  // a comment\n  "a": "https://x.example", /* b */\n  "c": [1, 2,],\n}'),
    ).toEqual({
      a: "https://x.example",
      c: [1, 2],
    });
  });
});
