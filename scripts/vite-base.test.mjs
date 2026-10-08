// What every Vite program in the repository shares, held where a build cannot see it break:
// with an app's `root` in `apps/<name>`, the shared UI is outside it, and the dev server
// answers 403 for a file outside `server.fs.allow`. A build and this suite never ask the dev
// server for anything, so `tauri dev` opening on a blank window would be the first report.
import { describe, expect, it } from "vitest";
import base, { REPO, UI } from "../vite.base.ts";

const slashes = (p) => p.replaceAll("\\", "/").replace(/\/$/, "");

describe("vite.base.ts", () => {
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
