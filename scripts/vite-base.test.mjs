// What every Vite program in the repository shares, held where a build cannot see it break:
// with an app's `root` in `apps/<name>`, the shared UI is outside it, and the dev server
// answers 403 for a file outside `server.fs.allow`. A build and this suite never ask the dev
// server for anything, so the line is held by what it says. It is not, today, a line whose loss
// would blank a window: `vite.base.ts` records the measurement (2026-10-08, the dev server
// answered 200 for shared-UI modules with it taken out, Vite's default reaching the repository
// as well), and Vite's default goes on reaching it: each app has a `package.json` of its own since the workspace, and the root's `pnpm-workspace.yaml` is what the default looks for first.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import base, { REPO, UI } from "../vite.base.ts";

const slashes = (p) => p.replaceAll("\\", "/").replace(/\/$/, "");

describe("vite.base.ts", () => {
  // Every other assertion here derives its expected value from `REPO`, so none of them can fail
  // if `REPO` itself is wrong: these two name it from outside.
  it("takes the repository to be the folder that holds the workspace file and the shared UI", () => {
    // Every app has a `package.json` since 2026-10-08; only the root has this file.
    expect(existsSync(`${REPO}/pnpm-workspace.yaml`)).toBe(true);
    expect(existsSync(`${UI}/index.css`)).toBe(true);
  });

  it("lets the dev server read the whole repository", () => {
    expect(base.server.fs.allow.map(slashes)).toContain(slashes(REPO));
  });

  it("points `@` at the shared UI", () => {
    expect(slashes(UI)).toBe(`${slashes(REPO)}/packages/ui`);
    expect(slashes(base.resolve.alias["@"])).toBe(slashes(UI));
  });

  it("resolves React and the query library once, from a program's root", () => {
    expect(base.resolve.dedupe).toEqual(["react", "react-dom", "@tanstack/react-query"]);
  });

  // Vite resolves a deduped name from the program's root. Vitest's and Storybook's root is the
  // repository, and two of the apps do not import the query library themselves: the root
  // manifest is where all three have to be declared.
  it("declares every deduped name in the root manifest", () => {
    const manifest = JSON.parse(readFileSync(`${REPO}/package.json`, "utf8"));
    for (const name of base.resolve.dedupe) expect(Object.keys(manifest.devDependencies)).toContain(name);
  });

  it("reads .env files from the repository root, wherever an app's root is", () => {
    expect(slashes(base.envDir)).toBe(slashes(REPO));
  });
});
