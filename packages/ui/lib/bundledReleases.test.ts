import { describe, expect, it } from "vitest";
import { APP_RELEASED, APP_VERSION, RELEASE_DATES } from "./appVersion";
import { BUNDLED_RELEASES, releasesFrom } from "./bundledReleases";

/** The repository's own notes and manifest, read as the suite reads every file: through Vite. */
const NOTES = import.meta.glob<string>("/changelog/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
const MANIFEST = import.meta.glob<string>("/package.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("releasesFrom", () => {
  const files = {
    "../../../changelog/0.9.0.md": "nine",
    "../../../changelog/0.10.0.md": "ten",
    "../../../changelog/0.11.0.md": "eleven",
    "../../../changelog/README.md": "not a release",
  };

  it("lists every release up to the running one, newest first by number", () => {
    const releases = releasesFrom(files, "0.10.0", { "0.10.0": "2026-08-20" });
    expect(releases.map((r) => r.version)).toEqual(["0.10.0", "0.9.0"]);
    expect(releases[0]).toEqual({
      version: "0.10.0",
      tag: "v0.10.0",
      notes: "ten",
      publishedAt: "2026-08-20",
      htmlUrl: "https://github.com/Msgaihede/mtg-grimoire/releases/tag/v0.10.0",
    });
    // A release the log has no day for is drawn without one, as the desktop draws GitHub's.
    expect(releases[1]?.publishedAt).toBeNull();
  });
});

describe("this build's history", () => {
  it("is the root manifest's version", () => {
    const manifest = Object.values(MANIFEST)[0];
    expect(manifest).toBeDefined();
    expect(APP_VERSION).toBe(JSON.parse(manifest ?? "{}").version);
  });

  // Not "starting at this build": a release published without its notes file keeps
  // release-please's body on GitHub (`release.yml`'s `publish`), and has no row here.
  it("carries every release's notes file up to this build, newest first", () => {
    const upToHere = releasesFrom(NOTES, APP_VERSION, {}).map((r) => r.version);
    expect(BUNDLED_RELEASES.map((r) => r.version)).toEqual(upToHere);
    expect(BUNDLED_RELEASES.length).toBeGreaterThan(0);
    for (const release of BUNDLED_RELEASES) {
      expect(release.notes).toBe(NOTES[`/changelog/${release.version}.md`]);
    }
  });

  it("dates every release from the log", () => {
    expect(APP_RELEASED).toBe(RELEASE_DATES[APP_VERSION] ?? null);
    for (const release of BUNDLED_RELEASES) {
      expect(release.publishedAt, release.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
