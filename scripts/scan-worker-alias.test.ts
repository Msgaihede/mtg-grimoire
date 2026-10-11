// What the scan inbox's script imports, in a job that installs only wrangler —
// `release.yml`'s `scan-deploy` checks the repository out and runs no pnpm, so nothing links
// `@grimoire/relay` into that folder there. `share-worker-alias.test.ts` holds the same rule
// for the share Worker, which reaches the same module for the same reason: the relay's token.
import { describe, expect, it } from "vitest";
import wranglerText from "../infrastructure/scan-worker/wrangler.jsonc?raw";
import shareWranglerText from "../infrastructure/share-worker/wrangler.jsonc?raw";
import tokenText from "../infrastructure/relay/src/token.ts?raw";

const OWN = import.meta.glob<string>("/infrastructure/scan-worker/src/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The config as a value: comments and trailing commas out, strings left alone. */
function jsonc(text: string) {
  const bare = text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, string) => string ?? "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(bare);
}

/** Every specifier a source names — `from "x"`, `import "x"`, `import("x")` — comments out. */
const named = (source: string) =>
  [
    ...source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
      .matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g),
  ].map(([, spec]) => spec);

describe("what the scan inbox's script imports, in a job that installs only wrangler", () => {
  /** The folder's modules by `./name.ts`, less the tests and the declarations. */
  const modules = Object.entries(OWN)
    .map(([path, source]) => [`./${path.slice(path.lastIndexOf("/") + 1)}`, source])
    .filter(([path]) => !/\.(?:test|d)\.ts$/.test(path));

  it("is a file beside it, or a module `wrangler.jsonc` gives a path for", () => {
    const paths = modules.map(([path]) => path).sort();
    expect(paths).toContain("./index.ts");
    expect(paths).toContain("./auth.ts");
    const specs = modules.flatMap(([, source]) => named(source));
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

  it("gives the path the share Worker gives, from a folder beside it", () => {
    // Two Workers, one module, one spelling of the way to it: a path that worked for one and
    // was mistyped for the other would bundle in the suite, where pnpm links the package, and
    // fail in the one job that does not.
    expect(jsonc(wranglerText).alias).toEqual(jsonc(shareWranglerText).alias);
  });

  it("reaches a module that imports nothing of its own", () => {
    expect(tokenText).toContain("export async function verify");
    expect(named(tokenText)).toEqual([]);
  });

  it("bundles the half of that module that checks a token, and not the half that makes one", () => {
    // What `wrangler deploy` uploads is what `index.ts` reaches. `fake.ts` is the suite's
    // stand-in and mints the tokens it sends; nothing the Worker runs may import it, or the
    // deployed script would carry a function that signs with the relay's key.
    const reached = new Set<string>();
    const walk = (path: string) => {
      if (reached.has(path)) return;
      reached.add(path);
      const source = modules.find(([name]) => name === path)?.[1] ?? "";
      for (const spec of named(source).filter((s) => s.startsWith("."))) walk(`${spec}.ts`);
    };
    walk("./index.ts");
    expect([...reached].sort()).toEqual([
      "./auth.ts",
      "./cors.ts",
      "./env.ts",
      "./index.ts",
      "./label.ts",
      "./submit.ts",
    ]);
    const bundled = modules.filter(([path]) => reached.has(path));
    expect(bundled.filter(([, source]) => /\bmint\b/.test(source)).map(([path]) => path)).toEqual(
      [],
    );
  });
});
