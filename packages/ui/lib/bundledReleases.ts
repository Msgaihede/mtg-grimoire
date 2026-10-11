import { APP_VERSION, RELEASE_DATES } from "@/lib/appVersion";
import type { ReleaseNote } from "@/lib/ipc";

/**
 * Every release up to this build, with its notes, as the build carries them — the light edition's
 * version history.
 *
 * **The notes are `changelog/<version>.md`, which `release.yml`'s `publish` makes each release's
 * GitHub body**: the very text the desktop's history reads back from GitHub, read here off the
 * disk at build time instead. A light host has no updater and no `update_history` to ask, and
 * needs none — its notes cannot be newer than the page that draws them.
 *
 * **Never imported statically.** The files are a quarter of a megabyte of text, so this module is
 * reached through `import()` alone (`useBundledHistory`), and the chunk is fetched the first time
 * a reader opens the panel. The desktop build carries the chunk too (its `SettingsPage` holds both
 * panels) but never fetches it: its Updates panel reads GitHub's history.
 */
const FILES = import.meta.glob<string>("../../../changelog/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

const RELEASES = "https://github.com/Msgaihede/mtg-grimoire/releases";

/** `…/changelog/0.44.0.md` → `0.44.0`; any other name is not a release's. */
const FILE_NAME = /(?:^|\/)(\d+\.\d+\.\d+)\.md$/;

const parts = (version: string) => version.split(".").map(Number);

/** Newest first, by number rather than by text: `0.10.0` is after `0.9.0`. */
function newestFirst(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (y[i] ?? 0) - (x[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The history, from the notes' files, the version running, and each release's day.
 *
 * **Nothing after `current`**: a file for a release this build is older than is not this build's
 * past. `main` never carries one — the coming release's file reaches it with the release itself —
 * but a build of a release branch would, and this keeps that honest.
 */
export function releasesFrom(
  files: Readonly<Record<string, string>>,
  current: string,
  dates: Readonly<Partial<Record<string, string>>>,
): ReleaseNote[] {
  const versions: [string, string][] = [];
  for (const [path, notes] of Object.entries(files)) {
    const version = FILE_NAME.exec(path)?.[1];
    if (version !== undefined && newestFirst(version, current) >= 0)
      versions.push([version, notes]);
  }
  return versions
    .sort(([a], [b]) => newestFirst(a, b))
    .map(([version, notes]) => ({
      version,
      tag: `v${version}`,
      notes,
      publishedAt: dates[version] ?? null,
      htmlUrl: `${RELEASES}/tag/v${version}`,
    }));
}

/** This build's history. */
export const BUNDLED_RELEASES: readonly ReleaseNote[] = releasesFrom(
  FILES,
  APP_VERSION,
  RELEASE_DATES,
);
