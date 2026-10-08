// What every Vite program in the repository shares, held where a build cannot see it break:
// with an app's `root` in `apps/<name>`, the shared UI is outside it, and the dev server
// answers 403 for a file outside `server.fs.allow`. A build and this suite never ask the dev
// server for anything, so the line is held by what it says. It is not, today, a line whose loss
// would blank a window: `vite.base.ts` records the measurement (2026-10-08, the dev server
// answered 200 for shared-UI modules with it taken out, Vite's default reaching the repository
// as well), and it stops being so the day an app has a `package.json` of its own.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import base, { REPO, UI } from "../vite.base.ts";

const slashes = (p) => p.replaceAll("\\", "/").replace(/\/$/, "");

describe("vite.base.ts", () => {
  // Every other assertion here derives its expected value from `REPO`, so none of them can fail
  // if `REPO` itself is wrong: these two name it from outside.
  it("takes the repository to be the folder that holds package.json and the shared UI", () => {
    expect(existsSync(`${REPO}/package.json`)).toBe(true);
    expect(existsSync(`${UI}/index.css`)).toBe(true);
  });

  it("lets the dev server read the whole repository", () => {
    expect(base.server.fs.allow.map(slashes)).toContain(slashes(REPO));
  });

  it("points `@` at the shared UI", () => {
    expect(slashes(UI)).toBe(`${slashes(REPO)}/packages/ui`);
    expect(slashes(base.resolve.alias["@"])).toBe(slashes(UI));
  });

  it("reads .env files from the repository root, wherever an app's root is", () => {
    expect(slashes(base.envDir)).toBe(slashes(REPO));
  });
});
